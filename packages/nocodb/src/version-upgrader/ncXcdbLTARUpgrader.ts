import { RelationTypes, UITypes } from 'nocodb-sdk';
import NocoCache from '../cache/NocoCache';
import { MetaTable } from '../meta/meta.service';
import { Base } from '../models';
import NcConnectionMgrv2 from '../utils/common/NcConnectionMgrv2';
import { CacheGetType, CacheScope } from '../utils/globals';
import { Model } from '../models';
import type { LinkToAnotherRecordColumn } from '../models';
import type { MetaService } from '../meta/meta.service';
import type { NcUpgraderCtx } from './NcUpgrader';

// An upgrader for upgrading LTAR relations in XCDB bases
// it will delete all the foreign keys and create a new index
// and treat all the LTAR as virtual

async function upgradeModelRelations({
  model,
  relations,
  ncMeta,
  sqlClient,
}: {
  ncMeta: MetaService;
  model: Model;
  sqlClient: ReturnType<
    (typeof NcConnectionMgrv2)['getSqlClient']
  > extends Promise<infer U>
    ? U
    : ReturnType<(typeof NcConnectionMgrv2)['getSqlClient']>;
  relations: {
    tn: string;
    rtn: string;
    cn: string;
    rcn: string;
  }[];
}) {
  // Iterate over each column and upgrade LTAR
  for (const column of await model.getColumns(ncMeta)) {
    if (column.uidt !== UITypes.LinkToAnotherRecord) {
      continue;
    }

    const colOptions = await column.getColOptions<LinkToAnotherRecordColumn>(
      ncMeta,
    );

    switch (colOptions.type) {
      case RelationTypes.HAS_MANY:
        {
          // skip if virtual
          if (colOptions.virtual) {
            break;
          }

          const parentCol = await colOptions.getParentColumn(ncMeta);
          const childCol = await colOptions.getChildColumn(ncMeta);

          const parentModel = await parentCol.getModel(ncMeta);
          const childModel = await childCol.getModel(ncMeta);

          // delete the foreign key constraint if exists
          const relation = relations.find((r) => {
            return (
              parentCol.column_name === r.rcn &&
              childCol.column_name === r.cn &&
              parentModel.table_name === r.rtn &&
              childModel.table_name === r.tn
            );
          });

          // delete the relation
          if (relation) {
            await sqlClient.relationDelete({
              parentColumn: relation.rcn,
              childColumn: relation.cn,
              parentTable: relation.rtn,
              childTable: relation.tn,
            });
          }

          // skip postgres since we were already creating the index while creating the relation
          if (ncMeta.knex.clientType() !== 'pg') {
            // create a new index for the column
            const indexArgs = {
              columns: [relation.cn],
              tn: relation.tn,
              non_unique: true,
            };
            await sqlClient.indexCreate(indexArgs);
          }
        }
        break;
    }

    // update the relation as virtual
    await ncMeta.metaUpdate(
      null,
      null,
      MetaTable.COL_RELATIONS,
      { virtual: true },
      colOptions.id,
    );

    // update the cache as well
    const cachedData = await NocoCache.get(
      `${CacheScope.COL_RELATION}:${colOptions.fk_column_id}`,
      CacheGetType.TYPE_OBJECT,
    );
    if (cachedData) {
      cachedData.virtual = true;
      await NocoCache.set(
        `${CacheScope.COL_RELATION}:${colOptions.fk_column_id}`,
        cachedData,
      );
    }
  }
}

// An upgrader for upgrading any existing relation in xcdb
async function upgradeBaseRelations({
  ncMeta,
  base,
}: {
  ncMeta: MetaService;
  base: any;
}) {
  // const sqlMgr = ProjectMgrv2.getSqlMgr({ id: base.project_id }, ncMeta);

  const sqlClient = await NcConnectionMgrv2.getSqlClient(base, ncMeta.knex);

  // get all relations
  const relations = (await sqlClient.relationListAll())?.data?.list;

  // get models for the base
  const models = await ncMeta.metaList2(null, base.id, MetaTable.MODELS);

  // get all columns and filter out relations and upgrade
  for (const model of models) {
    await upgradeModelRelations({
      ncMeta,
      model: new Model(model),
      sqlClient,
      relations,
    });
  }
}

// database to virtual relation and create an index for it
export default async function ({ ncMeta }: NcUpgraderCtx) {
  // get all xcdb bases
  const bases = await ncMeta.metaList2(null, null, MetaTable.BASES, {
    condition: {
      is_meta: 1,
    },
    orderBy: {},
  });

  // iterate and upgrade each base
  for (const base of bases) {
    await upgradeBaseRelations({
      ncMeta,
      base: new Base(base),
    });
  }
}
