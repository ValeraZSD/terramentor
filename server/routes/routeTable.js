// How a route file registers its routes without owning the app.
//
// Each file in server/routes/ starts with `const app = routeTable('<name>')` and
// then registers exactly as it would on an Express app (`app.get(...)`,
// `app.post(...)`), at the top level of the module. Nothing is registered on a
// real app yet: the calls are RECORDED, and `app.takeRoutes()` closes the
// recorded calls into a block that the file exports. createApp() in
// server/app.js mounts every block on the real app in one list, which is the
// only place the order is decided.
//
// Why a recorder and not express.Router: Express matches in registration order,
// so the server's order is part of its behaviour, and a Router is a layer of its
// own that answers OPTIONS from its own routes only. Replaying the recorded
// calls onto the app gives one stack in one order, the same one the server had
// when every route lived in a single file. tools/route-table-gates.mjs checks
// it: every route file mounted, the routes before the password check, and no
// route that an earlier one answers first.

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'set'];
const tables = [];

export function routeTable(name) {
    let pending = [];
    const blocks = [];
    const table = { name, blocks };
    for (const method of METHODS) {
        table[method] = (...args) => {
            // `app.get('setting')` reads a setting on a real app; there is no app here to read.
            if (method === 'get' && args.length < 2) throw new Error(`routeTable(${name}): app.get needs a handler`);
            pending.push({ method, args });
            return table;
        };
    }
    /** Close the calls recorded since the last block into a block createApp mounts. */
    table.takeRoutes = () => {
        const block = { table: name, calls: pending };
        pending = [];
        blocks.push(block);
        return block;
    };
    table.pendingCount = () => pending.length;
    tables.push(table);
    return table;
}

/** Replay a block's calls onto a real Express app, in the order they were recorded. */
export function mountRoutes(app, block) {
    for (const { method, args } of block.calls) app[method](...args);
}

/**
 * Throw when a route was recorded and never closed into a block, or a block was
 * never mounted: either way a route would silently not exist.
 */
export function assertEveryBlockMounted(mounted) {
    for (const table of tables) {
        if (table.pendingCount()) throw new Error(`routeTable('${table.name}') recorded ${table.pendingCount()} call(s) after its last takeRoutes()`);
        for (const block of table.blocks) {
            if (!mounted.has(block)) throw new Error(`a block of routeTable('${table.name}') is never mounted in createApp`);
        }
    }
}
