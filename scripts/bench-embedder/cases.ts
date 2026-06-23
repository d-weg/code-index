// Shared eval cases (mirrors scripts/eval.ts) + repo root.
// Set BENCH_REPO to a target repo; these cases targeted a private test repo.
export interface EvalCase {
  layer: "backend" | "mobile";
  task: string;
  expect: string[];
}

export const REPO = process.env.BENCH_REPO ?? "";

export const CASES: EvalCase[] = [
  {
    layer: "backend",
    task: "accept a bid: reject the sibling bids and flip the repair request status atomically",
    expect: ["apps/backend/src/features/bids/bids.service.ts"],
  },
  {
    layer: "backend",
    task: "presign a private R2 url for an original photo and serve a blurred public CDN copy to locked viewers",
    expect: [
      "apps/backend/src/services/storage/index.ts",
      "apps/backend/src/features/media/media.service.ts",
      "apps/backend/src/features/requests/requests.service.ts",
    ],
  },
  {
    layer: "backend",
    task: "run Gemini damage assessment on uploaded photos and return a minimum repair cost estimate",
    expect: ["apps/backend/src/services/ai/damage-assessment.ts"],
  },
  {
    layer: "backend",
    task: "deduct a credit atomically when a shop unlocks a repair lead",
    expect: [
      "apps/backend/src/features/unlocks/unlocks.service.ts",
      "apps/backend/src/features/billings/billings.service.ts",
    ],
  },
  {
    layer: "mobile",
    task: "render the my-bids screen layout listing the shop's submitted bids with status badges",
    expect: ["apps/mobile/app/(shop)/my-bids.tsx"],
  },
  {
    layer: "mobile",
    task: "the bid store slice holding bid state and screen navigation on mobile",
    expect: ["apps/mobile/src/store/slices/bid-store.ts"],
  },
];
