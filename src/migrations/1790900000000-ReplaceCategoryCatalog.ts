import type { MigrationInterface, QueryRunner } from 'typeorm';

type CategoryType = 'income' | 'expense';

interface CatalogEntry {
  type: CategoryType;
  name: string;
  icon: string;
  color: string;
}

interface StoredCategory {
  id: number;
  space_id: number;
  name: string;
  transaction_type: CategoryType;
  icon: string;
  is_active: number;
}

interface LimitLink {
  limit_id: number;
  limit_space_id: number;
  limit_name: string | null;
  category_id: number;
  category_space_id: number;
}

interface Mapping {
  target: string;
  // 0 = same name, 1 = known rename, 2 = by icon or fallback; only 0 and 1 keep their id
  rank: 0 | 1 | 2;
}

// Snapshot of the approved starter catalog, in display order. Migrations must
// not import application source, which keeps changing after they ship.
const CATALOG: CatalogEntry[] = [
  { type: 'income', name: 'Salary', icon: 'Salary', color: 'evergreen' },
  { type: 'income', name: 'Freelance', icon: 'Freelance', color: 'indigo' },
  { type: 'income', name: 'Gifts', icon: 'Gifts', color: 'clay' },
  { type: 'income', name: 'Other income', icon: 'Other', color: 'slate' },
  { type: 'expense', name: 'Groceries', icon: 'Grocery', color: 'evergreen' },
  { type: 'expense', name: 'Eating out', icon: 'Restaurant', color: 'clay' },
  { type: 'expense', name: 'Housing', icon: 'Housing', color: 'slate' },
  { type: 'expense', name: 'Utilities', icon: 'Utilities', color: 'amber' },
  { type: 'expense', name: 'Transport', icon: 'Transport', color: 'indigo' },
  { type: 'expense', name: 'Car', icon: 'Car', color: 'slate' },
  { type: 'expense', name: 'Health', icon: 'Health', color: 'clay' },
  { type: 'expense', name: 'Personal care', icon: 'Beauty', color: 'amber' },
  { type: 'expense', name: 'Clothes', icon: 'Clothes', color: 'plum' },
  { type: 'expense', name: 'Home goods', icon: 'Home goods', color: 'evergreen' },
  { type: 'expense', name: 'Entertainment', icon: 'Entertainment', color: 'amber' },
  { type: 'expense', name: 'Subscriptions', icon: 'Subscriptions', color: 'indigo' },
  { type: 'expense', name: 'Education', icon: 'Education', color: 'slate' },
  { type: 'expense', name: 'Travel', icon: 'Travel', color: 'indigo' },
  { type: 'expense', name: 'Gifts', icon: 'Gifts', color: 'clay' },
  { type: 'expense', name: 'Other expenses', icon: 'Other', color: 'slate' },
];

const FALLBACK: Record<CategoryType, string> = { income: 'Other income', expense: 'Other expenses' };

// the 100/200 ranges CategoriesService.reorder() writes
const SORT_PREFIX: Record<CategoryType, number> = { income: 100, expense: 200 };

// keys are normalize()d names
const NAME_ALIASES: Record<CategoryType, Record<string, string>> = {
  income: {
    bonus: 'Salary',
    wage: 'Salary',
    wages: 'Salary',
    paycheck: 'Salary',
    gift: 'Gifts',
    other: 'Other income',
    others: 'Other income',
    misc: 'Other income',
  },
  expense: {
    grocery: 'Groceries',
    supermarket: 'Groceries',
    restaurant: 'Eating out',
    restaurants: 'Eating out',
    cafe: 'Eating out',
    cafes: 'Eating out',
    coffee: 'Eating out',
    dining: 'Eating out',
    'dining out': 'Eating out',
    rent: 'Housing',
    mortgage: 'Housing',
    utility: 'Utilities',
    internet: 'Utilities',
    taxi: 'Transport',
    transportation: 'Transport',
    'public transport': 'Transport',
    fuel: 'Car',
    petrol: 'Car',
    parking: 'Car',
    pharmacy: 'Health',
    medicine: 'Health',
    fitness: 'Health',
    gym: 'Health',
    beauty: 'Personal care',
    clothing: 'Clothes',
    electronics: 'Home goods',
    household: 'Home goods',
    subscription: 'Subscriptions',
    vacation: 'Travel',
    gift: 'Gifts',
    other: 'Other expenses',
    others: 'Other expenses',
    misc: 'Other expenses',
  },
};

// keys are CategoryIcon values; an icon missing here maps to FALLBACK
const ICON_ALIASES: Record<CategoryType, Record<string, string>> = {
  income: { Salary: 'Salary', Bonus: 'Salary', Freelance: 'Freelance', Gifts: 'Gifts' },
  expense: {
    Grocery: 'Groceries',
    Restaurant: 'Eating out',
    Cafe: 'Eating out',
    Housing: 'Housing',
    Utilities: 'Utilities',
    Internet: 'Utilities',
    Transport: 'Transport',
    Taxi: 'Transport',
    Car: 'Car',
    Fuel: 'Car',
    Health: 'Health',
    Pharmacy: 'Health',
    Fitness: 'Health',
    Beauty: 'Personal care',
    Clothes: 'Clothes',
    Electronics: 'Home goods',
    'Home goods': 'Home goods',
    Entertainment: 'Entertainment',
    Subscriptions: 'Subscriptions',
    Education: 'Education',
    Travel: 'Travel',
    Gifts: 'Gifts',
  },
};

// group spaces get categories when created, personal ones on email verification
const ELIGIBLE_SPACE = `(s.type = 'group' OR EXISTS (
  SELECT 1 FROM space_members m INNER JOIN users u ON u.id = m.user_id
  WHERE m.space_id = s.id AND m.role = 'owner' AND u.email_verified = 1
))`;

const normalize = (name: string) =>
  name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const targetKey = (type: CategoryType, name: string) => `${type}:${name}`;

function mapCategory(category: Pick<StoredCategory, 'name' | 'transaction_type' | 'icon'>): Mapping {
  const type = category.transaction_type;
  const name = normalize(category.name);
  const same = CATALOG.find((entry) => entry.type === type && normalize(entry.name) === name);

  if (same) {
    return { target: same.name, rank: 0 };
  }

  const renamed = NAME_ALIASES[type][name];

  if (renamed) {
    return { target: renamed, rank: 1 };
  }

  return { target: ICON_ALIASES[type][category.icon] ?? FALLBACK[type], rank: 2 };
}

// Replaces every ordinary category of initialized spaces with CATALOG.
// Transactions and limits move to the category their old one maps to; the
// system "Initial balance" category is left alone. Stops before writing
// anything if the move would merge or reshape a limit.
export class ReplaceCategoryCatalog1790900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await inOwnTransaction(queryRunner, () => this.replace(queryRunner));
  }

  public async down(): Promise<void> {
    // the replaced categories are gone, and their transactions cannot be told apart
  }

  private async replace(queryRunner: QueryRunner): Promise<void> {
    // spaces (X) first: the app takes the space row before categories, limits and transactions
    const spaces: { id: number }[] = await queryRunner.query(
      `SELECT s.id AS id FROM spaces s WHERE ${ELIGIBLE_SPACE} ORDER BY s.id FOR UPDATE OF s`,
    );
    const eligible = new Set(spaces.map((space) => Number(space.id)));

    if (eligible.size === 0) {
      return;
    }

    const categories: StoredCategory[] = (
      await queryRunner.query(
        `SELECT c.id, c.space_id, c.name, c.transaction_type, c.icon, c.is_active
         FROM categories c INNER JOIN spaces s ON s.id = c.space_id
         WHERE c.is_system = 0 AND ${ELIGIBLE_SPACE}
         ORDER BY c.id FOR UPDATE OF c`,
      )
    ).map((row: StoredCategory) => ({ ...row, id: Number(row.id), space_id: Number(row.space_id) }));

    const links: LimitLink[] = (
      await queryRunner.query(
        `SELECT l.id AS limit_id, l.space_id AS limit_space_id, l.name AS limit_name,
                c.id AS category_id, c.space_id AS category_space_id
         FROM limit_categories lc
         INNER JOIN limits l ON l.id = lc.limit_id
         INNER JOIN categories c ON c.id = lc.category_id
         ORDER BY l.id, c.id FOR UPDATE OF lc`,
      )
    )
      .map((row: LimitLink) => ({
        ...row,
        limit_id: Number(row.limit_id),
        limit_space_id: Number(row.limit_space_id),
        category_id: Number(row.category_id),
        category_space_id: Number(row.category_space_id),
      }))
      .filter((link: LimitLink) => eligible.has(link.limit_space_id) || eligible.has(link.category_space_id));

    const byId = new Map(categories.map((category) => [category.id, category]));
    const mappings = new Map(categories.map((category) => [category.id, mapCategory(category)]));

    const conflicts = findLimitConflicts(links, byId, mappings);

    if (conflicts.length) {
      throw new Error(
        `Category catalog replacement stopped before changing any data: ${conflicts.length} limit conflict(s). ` +
          'Edit or delete these limits, then run the migrations again.\n' +
          conflicts.map((conflict) => `- ${conflict}`).join('\n'),
      );
    }

    const categoriesBySpace = groupBy(categories, (category) => category.space_id);
    const linksBySpace = groupBy(links, (link) => link.limit_space_id);

    for (const spaceId of eligible) {
      await this.replaceInSpace(
        queryRunner,
        spaceId,
        categoriesBySpace.get(spaceId) ?? [],
        mappings,
        linksBySpace.get(spaceId) ?? [],
      );
    }
  }

  private async replaceInSpace(
    queryRunner: QueryRunner,
    spaceId: number,
    categories: StoredCategory[],
    mappings: Map<number, Mapping>,
    links: LimitLink[],
  ): Promise<void> {
    const targetIds = new Map<string, number>();
    const position: Record<CategoryType, number> = { income: 0, expense: 0 };

    for (const entry of CATALOG) {
      const key = targetKey(entry.type, entry.name);
      const sort = SORT_PREFIX[entry.type] + ++position[entry.type];
      const keeper = categories
        .filter((category) => {
          const mapping = mappings.get(category.id)!;
          return category.transaction_type === entry.type && mapping.target === entry.name && mapping.rank < 2;
        })
        .sort(
          (a, b) => mappings.get(a.id)!.rank - mappings.get(b.id)!.rank || b.is_active - a.is_active || a.id - b.id,
        )[0];

      if (keeper) {
        await queryRunner.query(
          `UPDATE categories SET name = ?, icon = ?, color = ?, is_active = 1, archived_at = NULL, sort = ?
           WHERE id = ?`,
          [entry.name, entry.icon, entry.color, sort, keeper.id],
        );
        targetIds.set(key, keeper.id);
      } else {
        const inserted: { insertId: number } = await queryRunner.query(
          `INSERT INTO categories (space_id, name, transaction_type, icon, color, is_active, sort, is_system)
           VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
          [spaceId, entry.name, entry.type, entry.icon, entry.color, sort],
        );
        targetIds.set(key, Number(inserted.insertId));
      }
    }

    const replacement = new Map<number, number>();

    for (const category of categories) {
      const targetId = targetIds.get(targetKey(category.transaction_type, mappings.get(category.id)!.target))!;

      if (targetId !== category.id) {
        replacement.set(category.id, targetId);
        await queryRunner.query(
          'UPDATE transactions SET category_id = ?, version = version + 1 WHERE category_id = ?',
          [targetId, category.id],
        );
      }
    }

    for (const [limitId, limitLinks] of groupBy(links, (link) => link.limit_id)) {
      const current = limitLinks.map((link) => link.category_id);
      const wanted = [...new Set(current.map((id) => replacement.get(id) ?? id))];
      const removed = current.filter((id) => !wanted.includes(id));
      const added = wanted.filter((id) => !current.includes(id));

      if (removed.length) {
        await queryRunner.query('DELETE FROM limit_categories WHERE limit_id = ? AND category_id IN (?)', [
          limitId,
          removed,
        ]);
      }

      for (const categoryId of added) {
        await queryRunner.query('INSERT INTO limit_categories (limit_id, category_id) VALUES (?, ?)', [
          limitId,
          categoryId,
        ]);
      }
    }

    if (replacement.size) {
      await queryRunner.query('DELETE FROM categories WHERE id IN (?)', [[...replacement.keys()]]);
    }
  }
}

function findLimitConflicts(
  links: LimitLink[],
  categories: Map<number, StoredCategory>,
  mappings: Map<number, Mapping>,
): string[] {
  const conflicts: string[] = [];
  const label = (id: number) => {
    const category = categories.get(id);
    return category ? `"${category.name}" #${id}` : `#${id}`;
  };
  // a category another space owns, or the system one, stays itself
  const targetOf = (link: LimitLink) => {
    const category = categories.get(link.category_id);
    return category && category.space_id === link.limit_space_id
      ? targetKey(category.transaction_type, mappings.get(category.id)!.target)
      : `#${link.category_id}`;
  };
  const describeTarget = (target: string) => {
    const [type, name] = target.split(':');
    return name === undefined ? `category ${target}` : `${type} category "${name}"`;
  };

  const limits = groupBy(links, (link) => link.limit_id);

  const claims = new Map<string, Map<number, number[]>>();

  for (const [limitId, limitLinks] of limits) {
    const spaceId = limitLinks[0].limit_space_id;

    for (const link of limitLinks.filter((link) => link.category_space_id !== spaceId)) {
      conflicts.push(
        `space ${spaceId}: limit #${limitId} covers category ${label(link.category_id)} of space ${link.category_space_id}`,
      );
    }

    const targets = new Set(limitLinks.map(targetOf));

    if (limitLinks.length > 1 && targets.size === 1) {
      const name = limitLinks[0].limit_name ? ` "${limitLinks[0].limit_name}"` : '';
      conflicts.push(
        `space ${spaceId}: group limit #${limitId}${name} would cover only ${describeTarget([...targets][0])}, ` +
          `as all of ${limitLinks.map((link) => label(link.category_id)).join(', ')} map to it`,
      );
    }

    for (const link of limitLinks) {
      const key = `${spaceId}|${targetOf(link)}`;
      const byLimit = claims.get(key) ?? new Map<number, number[]>();
      byLimit.set(limitId, [...(byLimit.get(limitId) ?? []), link.category_id]);
      claims.set(key, byLimit);
    }
  }

  for (const [key, byLimit] of claims) {
    if (byLimit.size > 1) {
      const [spaceId, target] = key.split('|');
      const sources = [...byLimit].map(([limitId, ids]) => `limit #${limitId} via ${ids.map(label).join(', ')}`);
      conflicts.push(
        `space ${spaceId}: ${describeTarget(target)} would be in ${byLimit.size} limits: ${sources.join('; ')}`,
      );
    }
  }

  return conflicts;
}

function groupBy<T>(items: T[], keyOf: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const group = groups.get(keyOf(item));
    if (group) {
      group.push(item);
    } else {
      groups.set(keyOf(item), [item]);
    }
  }
  return groups;
}

// MySQL commits implicitly on DDL, so an earlier migration of the same run can
// end the run's transaction and leave later statements autocommitted.
async function inOwnTransaction(queryRunner: QueryRunner, work: () => Promise<void>): Promise<void> {
  if (queryRunner.isTransactionActive) {
    // commits what the run did so far; the runner commits or rolls back the rest
    await queryRunner.query('START TRANSACTION');
    await work();
    return;
  }

  await queryRunner.startTransaction();

  try {
    await work();
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}
