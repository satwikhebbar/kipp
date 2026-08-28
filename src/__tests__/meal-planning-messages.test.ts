import { describe, expect, it } from "vitest"
import { escapeTelegramMarkdown, renderPlanMessage } from "../meal-planning/messages"
import type { MealPlanRecord, MealPlanVersionRecord } from "../meal-planning/store"
import type { MealCell, MealGrid, MealPlanCandidate, MealPlanEvaluation, MealSchedule } from "../meal-planning/types"

const SCHEDULE: MealSchedule = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  slots: [
    { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
    { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
    { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
  ],
}

function cell(dish: string, recipeVideo?: MealCell["recipeVideo"]): MealCell {
  return {
    dish,
    vegetarian: true,
    items: [dish],
    cookMinutes: 15,
    priorNightPrep: false,
    ...(recipeVideo ? { recipeVideo } : {}),
  }
}

function grid(): MealGrid {
  const grid: MealGrid = {}
  for (const day of SCHEDULE.days) {
    grid[day] = {
      breakfast: cell("paratha"),
      "school-lunch": cell("idli"),
      "home-lunch": cell("rice and dal"),
    }
  }
  grid.Mon["school-lunch"] = cell("idli", {
    status: "found",
    url: "https://www.youtube.com/watch?v=abc",
    title: "Perfect Idli",
    channel: "Idli Chef",
  })
  return grid
}

const CANDIDATE: MealPlanCandidate = { grid: grid(), easyBuys: [], policyOutcomes: {} }

const EVALUATION: MealPlanEvaluation = {
  pass: true,
  failures: [],
  measurements: {
    morningCookByDay: {},
    morningCookMax: 0,
    priorNightPrepByDay: {},
    priorNightPrepMax: 0,
    dishRepeatCount: 0,
    dishRepeats: [],
    inventoryUsed: [],
    easyBuyCount: 0,
  },
}

const PLAN: MealPlanRecord = {
  planId: "p-1",
  chatId: "100",
  weekStart: "2026-09-07T00:00:00.000Z",
  weekEnd: "2026-09-12T23:59:59.000Z",
  timezone: "Asia/Kolkata",
  instanceId: "meal-wf-1",
  status: "active",
  currentVersion: 1,
  weeklyInventory: { items: [], notes: [] },
  weeklyExceptions: { items: [] },
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
}

const VERSION: MealPlanVersionRecord = {
  planId: "p-1",
  version: 1,
  candidate: CANDIDATE,
  evaluation: EVALUATION,
  requestKind: "initial_plan",
  baseVersion: null,
  feedbackBatchId: null,
  video: {},
  createdAt: "2026-09-07T00:00:00.000Z",
}

describe("renderPlanMessage", () => {
  it("renders a video link only when a cell has a found recipe video", () => {
    const rendered = renderPlanMessage(PLAN, VERSION, SCHEDULE, [])
    expect(rendered).toContain("School week of")
    expect(rendered).toContain("Perfect Idli: https://www.youtube.com/watch?v=abc")
    expect(rendered).not.toContain("Recipe video")
    expect(rendered.match(/Recipe video|https:\/\/www\.youtube\.com/g)?.length).toBe(1)
  })

  it("escapes YouTube-controlled titles so they render literally in Markdown", () => {
    const evilGrid = grid()
    evilGrid.Mon["school-lunch"] = cell("idli", {
      status: "found",
      url: "https://www.youtube.com/watch?v=abc",
      title: "[click me](https://attacker.example) _all_ *bold* `code`",
      channel: "Whoever",
    })
    const rendered = renderPlanMessage(PLAN, { ...VERSION, candidate: { ...CANDIDATE, grid: evilGrid } }, SCHEDULE, [])
    expect(rendered).toContain(
      "\\[click me\\](https://attacker.example) \\_all\\_ \\*bold\\* \\`code\\`: https://www.youtube.com/watch?v=abc",
    )
  })

  it("leaves the meal intact and renders no URL when a recipe video is missing or unsuitable", () => {
    const missingGrid = grid()
    missingGrid.Mon["school-lunch"] = cell("idli", { status: "no_suitable_video" })
    missingGrid.Tue["school-lunch"] = cell("idli", { status: "not_attempted" })
    const rendered = renderPlanMessage(
      PLAN,
      { ...VERSION, candidate: { ...CANDIDATE, grid: missingGrid } },
      SCHEDULE,
      [],
    )
    expect(rendered).toContain("School lunch: idli")
    expect(rendered).not.toContain("Recipe video")
    expect(rendered).not.toContain("youtube.com")
  })

  it("escapes only Telegram Markdown special characters", () => {
    expect(escapeTelegramMarkdown("a_b *c* [d] `e` \\f")).toBe("a\\_b \\*c\\* \\[d\\] \\`e\\` \\\\f")
  })
})
