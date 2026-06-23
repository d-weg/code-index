// Big-chunk retry cost: when a large SET_BODY fails the type-check gate, what
// does recovery cost — re-emitting the whole chunk vs a scoped patch?
//
// Real execution: the bad attempt is actually rejected by the gate; both recovery
// paths are actually applied and pass the gate. Token = chars/4. The function is
// a constructed but realistic ~30-line body so the chunk-vs-fix contrast is clear;
// the gate runs and the counts are real.
import { Project } from "ts-morph";
import { commit, RefactorRunner } from "../src/edit/index.js";

const tok = (s: string) => Math.round(s.length / 4);
const NODE = "src/order.ts#fn_summarizeOrder";
const HEADER_SETBODY = `STRUCTURAL_EDIT: ${NODE}\nACTION: SET_BODY\nCODE:\n`;

const MODULE = `interface Order {
  id: string;
  status: "open" | "paid" | "shipped";
  total: number;
  items: { sku: string; qty: number; price: number; taxable: boolean }[];
}
interface Result { id: string; lines: number; subtotal: number; total: number; paid: boolean }

export function summarizeOrder(o: Order): Result {
  return { id: o.id, lines: o.items.length, subtotal: o.total, total: o.total, paid: o.status !== "open" };
}
`;

// The model's big rewrite — CORRECT version (~30 lines of statements).
const BIG_GOOD = `let subtotal = 0;
let lines = 0;
let taxableBase = 0;
for (const item of o.items) {
  if (item.qty <= 0) continue;
  const lineTotal = item.price * item.qty;
  subtotal += lineTotal;
  if (item.taxable) taxableBase += lineTotal;
  lines += 1;
}
let discount = 0;
if (subtotal > 500) discount = subtotal * 0.1;
else if (subtotal > 200) discount = subtotal * 0.05;
const discountedTaxable = Math.max(0, taxableBase - discount);
const tax = Math.round(discountedTaxable * 0.07 * 100) / 100;
const total = Math.round((subtotal - discount + tax) * 100) / 100;
const paid = o.status === "paid" || o.status === "shipped";
const result: Result = {
  id: o.id,
  lines,
  subtotal: Math.round(subtotal * 100) / 100,
  total,
  paid,
};
return result;`;

// Same rewrite, but one property is wrong: item.quantity (does not exist; it's qty).
const BIG_BAD = BIG_GOOD.replace("item.price * item.qty", "item.price * item.quantity");

// The scoped fix the model would emit if shown the diagnostic + its own code.
const FIX_OP = `STRUCTURAL_EDIT: ${NODE}\nACTION: REPLACE_TEXT\nOLD:\nitem.price * item.quantity\nNEW:\nitem.price * item.qty`;

const makeProject = () => {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: 99, module: 99, moduleResolution: 100 } });
  p.createSourceFile("src/order.ts", MODULE);
  return p;
};

async function main() {
  // 0. The model's first attempt: a big SET_BODY that's type-wrong.
  const initialEmit = tok(HEADER_SETBODY + BIG_BAD);
  const rej = await commit(makeProject(), [{ type: "SET_BODY", nodeId: NODE, body: BIG_BAD }], { write: false });
  console.log(`first attempt (big SET_BODY, ~${BIG_BAD.split("\n").length} lines): gate ${rej.ok ? "PASS" : "REJECTED"} ${rej.ok ? "" : "✓ (caught item.quantity)"}`);
  console.log(`  emitted: ${initialEmit} tokens\n`);

  // Path A — full re-emit: model resends the WHOLE corrected body.
  const reemit = tok(HEADER_SETBODY + BIG_GOOD);
  const aRes = await commit(makeProject(), [{ type: "SET_BODY", nodeId: NODE, body: BIG_GOOD }], { write: false });
  console.log(`Path A — full re-emit retry:   ${reemit} tokens   gate ${aRes.ok ? "PASS ✓" : "FAIL"}`);

  // Path B — scoped patch, now AUTOMATIC via commit()'s repair loop. The repair
  // callback stands in for the model: given the anchored diagnostic, it returns a
  // REPLACE_TEXT fixing only the error. The bad body is kept (sandbox), not redone.
  const patch = tok(FIX_OP);
  let repairSawAnchor = false;
  const bRes = await commit(
    makeProject(),
    [{ type: "SET_BODY", nodeId: NODE, body: BIG_BAD }],
    {
      write: false,
      repair: (diags) => {
        repairSawAnchor = diags[0]?.nodeId === NODE; // diagnostic anchored to the op
        return [{ type: "REPLACE_TEXT", nodeId: NODE, oldText: "item.price * item.quantity", newText: "item.price * item.qty" }];
      },
    },
  );
  console.log(`Path B — scoped-patch retry:   ${patch} tokens   gate ${bRes.ok ? "PASS ✓" : "FAIL"}   (auto-repair: ${bRes.ok ? `${(bRes as { repairRounds?: number }).repairRounds} round, anchored=${repairSawAnchor}` : "—"})`);

  console.log("\n" + "─".repeat(64));
  console.log(`retry cost:   full re-emit ${reemit}   vs   scoped patch ${patch}   →  ${(reemit / patch).toFixed(0)}× cheaper`);
  console.log(`total output (first attempt + retry):`);
  console.log(`  full re-emit:  ${initialEmit + reemit} tok`);
  console.log(`  scoped patch:  ${initialEmit + patch} tok   (${Math.round((1 - (initialEmit + patch) / (initialEmit + reemit)) * 100)}% less)`);
  console.log(`\nBoth recoveries produce valid, gate-passing code. The retry cost scales`);
  console.log(`with the FIX under scoped patch, with the CHUNK under full re-emit.`);
}

main();
