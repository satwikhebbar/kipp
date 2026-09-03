# School-Day Meal Planning Workflow — v1 Product Specification

> **Status:** Draft for product review  
> **Document role:** This is the product contract for the first School-Day Meal
> Planning workflow. It defines the user outcome and behavior, while leaving
> the delivery surface and technical architecture open.

## 1. Goal

Help a parent turn their household's dietary needs, available ingredients, and
that week's exceptions into an active, easy-to-scan school-week meal plan
for a child. The plan must be practical to follow and easy to adjust without
replanning the whole week.

The initial household use case is an Indian school-going child. The workflow
is profile-driven, however: household-specific schedules, diets, and habits
are configuration, never hard-coded assumptions.

## 2. Intended outcome

On Sunday, a parent can start a planning conversation, provide the week’s
exceptions and available vegetables, review an agent-proposed Monday–Saturday
plan at a glance, and make a few targeted feedback requests. In the absence of
pending feedback, the latest plan is the active plan for that week.

During the week, the parent can open the active plan, find an appropriate
video recipe for a chosen meal, or change one affected meal with minimal
disruption to the rest of the plan.

## 3. Scope

### In scope for v1

- A configurable school-week plan, initially Monday through Saturday.
- A configurable set of daily meal slots; the initial household profile has:
  1. Breakfast before school
  2. First school snack break
  3. Second school snack break
  4. Packed school lunch
  5. Home lunch after school
- Profile- and conversation-based planning rather than automatic learning.
- Free-text and voice-friendly entry of available vegetables and other
  week-specific inputs.
- Voice-friendly capture wherever the parent would otherwise need to type a
  short planning input or a meal-specific change request.
- A visual, mobile-friendly weekly grid and targeted per-meal feedback.
- Vegetarian school-meal planning as a workflow constant for the initial
  India-focused release.
- Video-first recipe discovery, with YouTube as the initial priority.
- Local, minimally disruptive midweek updates.

### Explicitly out of scope for v1

- A separate home-day meal template when school closes unexpectedly.
- Fully automated dietary learning from past plans, outcomes, or ratings.
- Mandatory grocery ordering, grocery-list management, or inventory tracking.
- A dedicated mobile application.
- Refrigerator-photo recognition of inventory. The first workflow should use
  spoken or typed inventory because arranging vegetables for a photo adds
  friction; photo input is a later enhancement.

## 4. User

**User:** the parent who plans, prepares, and packs the child’s food. The bot
user controls the household configuration and the active plan. v1 has no
household roles, sharing model, or separate approval persona.

The workflow must support another household later without copying the initial
family’s habits into product logic.

## 5. Planning context model

A plan can only earn quick approval if it reflects the parent’s real decision
environment, not merely a list of ingredients and dietary restrictions. This
section defines the *context the planner needs*. It is deliberately not yet a
storage schema, onboarding questionnaire, or implementation decision.

Every item of context should be understood as one of the following:

- **Hard constraint:** must never be violated.
- **Soft preference:** should be met where practical, but may trade off against
  another preference or a hard constraint.
- **Capability or operating limit:** describes what the household can actually
  prepare, pack, or serve.
- **Recurring target:** a desired balance over a day or week, rather than a
  rule that applies to every meal.
- **Week-specific fact:** applies to this particular planning run only.

### 5.1 Child eating profile

The planner needs to know the child as an eater, not only their dietary rules:

- Dietary exclusions: allergies, medical requirements, prohibited ingredients,
  or whole ingredient/category exclusions (**hard constraints**). Vegetarian
  school meals are a workflow constant for the initial India-focused release,
  rather than a household setting.
- Foods, ingredients, cuisines, and dish families the child strongly enjoys,
  plus foods to avoid suggesting. Avoidance is a soft preference; it is not a
  separate “refusal” concept and must not be confused with a hard dietary
  exclusion.
- Optional sensory guidelines, expressed as plain-language statements such as
  “avoid soggy food,” “no mushy textures,” “mild spice only,” or “does not like
  food that smells strongly by the second break.”
- A simple boolean for whether unfamiliar foods may be introduced in the plan.
  When enabled, the planner should pair a new item with familiar food rather
  than make the whole meal unfamiliar.
- Any child-specific school realities: food-sharing restrictions, utensil
  comfort, ability to peel fruit, or known tendency to skip a particular slot.

### 5.2 Household food repertoire and preferences

The agent needs a usable picture of what “normal food” means for this family:

- The household’s preferred cuisines, recurring dish families, and dishes they
  are happy to repeat occasionally.
- A household dish repertoire, classified by meal slot: breakfast, dry snack,
  packed lunch, and home lunch. A meal can be suitable for dinner yet
  unsuitable for a school lunch. This is a workflow-managed entity built from
  approved plans and later explicit learning/feedback; it is not a custom
  property.
- Ingredients and formats that work particularly well for the family—such as
  parathas, rice dishes, cheelas, roasted legumes, fruit, nuts, or leftovers—
  and those that create waste or are consistently rejected.
- Acceptable substitutions and the household’s tolerance for repeating a base
  ingredient in different forms within one week.
- Cultural, religious, seasonal, and special-occasion preferences that affect
  the plan.

### 5.3 School-day schedule and meal-slot rules

The template must express the actual school day rather than assume five equal
meals:

- Configured school days, holidays, half days, pickup changes, commute time,
  and break times and durations.
- Each configured meal slot’s purpose, timing, and recipient: breakfast before
  departure; first and second packed snacks; fresh packed school lunch; and
  home lunch shared with the family.
- Whether each slot must be packed, dry, leak-resistant, utensil-free, easy to
  eat quickly, or safe at room temperature for its expected duration.
- Any school-specific no-go policy, such as “no biscuits, chips, or junk food.”
  This is optional plain-language policy context; do not create a separate
  packed-food-suitability or “safety” field for it.
- Whether the home lunch is expected after school drop-off and may therefore
  use a separate cooking window.

### 5.4 Preparation, cooking, and packing capability

This is a first-class planning input. A meal is not a good suggestion if it is
individually simple but impossible in combination with the rest of the morning.

- Who normally cooks and packs, who else is getting ready, and which parts of
  the routine happen in parallel.
- The real pre-departure window, including a conservative allowance for waking,
  bathing, dressing, and supervision; a configurable active-cooking budget is
  more useful than a generic recipe duration.
- Which meals are normally cooked fresh: school lunch and home lunch are the
  default fresh-cooked meals; breakfast is preferred fresh when the morning
  workload permits it.
- The default snack operating model: dry, quick, and usually ready to pack.
  Examples include fruit, nuts, roasted lentils, roasted sprouts, and other
  configured snacks. A cooked snack must be both genuinely quick and justified
  against the morning budget.
- What can happen the prior night: soaking, chopping, batter preparation,
  roasting, batch preparation, and packing dry snacks; and how much prior-night
  prep the parent is actually willing to do.
- Any equipment gaps or packing constraints that matter for this household.
  These are examples of custom policy, not predeclared fields; for example,
  “Equipment gap: microwave oven” or “Use no more than two lunchbox
  compartments.”

### 5.5 Nutrition and weekly-balance policy

Health decisions are usually targets to balance, not one-off meal rules:

- Generic health defaults, including a health-focused overall plan and one
  configurable cheat day. The workflow may provide default advice, but it must
  not claim household-specific nutrition goals without input.
- Optional household targets such as fruit frequency, nuts/dry-fruit frequency,
  pulses, vegetables, dairy, or a refined-carbohydrate limit. These are custom
  policies when a parent wants to define them.
- Preferences around refined carbohydrates, fried food, packaged foods, sugar,
  and protein balance.
- A designated cheat day and what it permits (for example, cookies, pancakes,
  or puri) without treating the day as unconstrained.
- Desired variety across food groups, cuisines, textures, colours, and cooking
  methods through the week. The primary v1 check is against repeating a named
  dish; principal ingredients should normally appear no more than twice in a
  week unless the parent requests otherwise.
- Family priorities for a particular week, such as lighter meals, comfort food,
  extra fruit, or using up vegetables.

### 5.6 Ingredients, pantry, and procurement policy

The planner needs both what is present and what it may reasonably assume:

- Stable pantry baseline: grains, pulses, flours, spices, oils, dry snacks, and
  other staples the household normally keeps.
- Available perishable vegetables, fruits, dairy, and prepared items, ideally
  with approximate quantity, ripeness/urgency, and any item that should be
  used early in the week.
- Known shortages, ingredients that have run out, and items reserved for
  another meal.
- A default no-shopping policy. When necessary, the agent may make a short,
  clearly labelled list of easy-buy additions based on its judgment of what is
  standard grocery stock or seasonally available at the household's location.
  These items are convenience assumptions for urban households with quick
  commerce, not confirmed inventory.
- Household country and city, plus the plan's explicit date range and timezone.
  These ground seasonal availability and phrases such as “tomorrow.”
- The parent’s preferred inventory input method: a short spoken list or typed
  text in the initial version. Refrigerator photos are a later convenience, not
  a prerequisite.

### 5.7 Recent plans, variety, and explicit feedback

Variety across weeks requires deliberate history even before the platform has
automatic learning:

- The immediately preceding active plan, and ideally a small recent window,
  so the planner can avoid repeating the same dishes, dominant ingredients, or
  close variants without a reason.
- Meals deliberately retained as favourites or requested repeats, which should
  override a mechanical anti-repeat rule.
- Explicitly confirmed profile updates—such as “he now likes sprouts”—rather
  than inferred preferences from one edit.

The planner should use history to make an explainable variety check, not to
claim it has learned an unverified preference. Meal-specific revision comments
are transactional records, not planning context; they may contribute to later
learning only through an explicit, separate promotion process.

### 5.8 Recipe and execution support

Recipe support affects whether a parent will accept a less familiar meal:

- Trusted chefs, channels, cuisines, languages, and formats; YouTube is the
  initial video source.
- Whether the household needs a familiar recipe only, is open to a new recipe,
  or wants a very short preparation video.
- A fallback policy for the rare case where no suitable trusted-source recipe
  exists. The meal remains eligible when no video is found; lack of a video is
  not a reason to remove an otherwise suitable meal.
- Whether the plan should show an optional prior-night prep note, a cooking
  duration, or both for a given meal.

### 5.9 Week-specific planning input

At the beginning of each planning conversation, the agent asks concisely for
only the changed facts that matter for the coming week:

- School holidays, short days, events, travel, guests, or pickup changes.
- Available vegetables, fruit, and other perishables; known shortages; and
  permitted easy purchases.
- A requested focus such as lighter meals, a higher-health week, more variety,
  or a requested favourite.
- A temporary change to cooking capacity, schedule, appliances, or ability to
  do prior-night preparation.
- A request to avoid or include a specific dish or ingredient that week.

The inventory prompt must work particularly well as a short voice message or
dictation, since it is normally easier to list available vegetables and fruits
than to arrange and photograph them. The agent should not force a long
questionnaire when no exceptions exist.

### 5.10 Context quality and parent control

The platform must ultimately make this context safe to use and easy to correct:

- Clearly show which facts are hard constraints, household defaults, and
  week-only inputs when a parent reviews a plan.
- Preserve the source and scope of a consequential fact: for example, whether
  it was saved to the household profile, supplied for this week, or copied from
  a previous active plan.
- Let the parent correct, remove, or confirm context explicitly. Do not turn a
  one-off meal edit into a permanent preference without confirmation.
- Handle missing or uncertain information transparently: ask a short question
  or make a clearly labelled, low-risk assumption rather than presenting it as
  known fact.

### 5.11 Context classification for capture and use

The categories above describe *what* the planner needs. The workflow needs a
stricter distinction between two kinds of configuration:

- **Generic property:** a concept the platform knows in code, with a defined
  name, semantics, and shape. It may be optional and have a default value, but
  the platform knows how to collect and apply it. A generic property can still
  have a household-specific value; “generic” describes the *property*, not who
  it applies to.
- **Custom property:** a user-created policy or override for which the platform
  has no predeclared property. It has a user-supplied name and a natural-language
  value (or simple list), and the planner interprets it as policy. Examples are
  “Equipment gap: microwave oven” and “Lunchbox rule: no more than two
  compartments.”

“Structured” and “unstructured” describe a value’s shape, not whether it is
generic or custom. A generic `dietaryExclusions` property may be a structured
array of natural-language strings, while a custom `snackPolicy` property is an
unstructured policy string.

#### Generic properties

The following properties are known to the platform from the start. Defaults
are starting points, not household facts.

| Property | Shape and example | Default / how used |
| --- | --- | --- |
| `dietaryExclusions` | Array of natural-language strings, e.g. `["dairy", "egg"]` or `["dairy products"]` | Empty list. Every entry is a hard exclusion. The planner interprets ingredient categories and their descendants; it does not require a v1 ingredient enum or food taxonomy. Ambiguous wording must be clarified before use as a hard rule. |
| `foodPreferences` | `{ favourites: string[], avoid: string[] }` | Empty lists. `avoid` is a soft “do not suggest” signal; only `dietaryExclusions` is a hard ban. There is no separate “refusal” field. |
| `allowNewFoods` | Boolean | `false` by default, so the first plan prefers familiar food. When true, a new item is paired with familiar food. |
| `sensoryGuidelines` | Array of plain-language strings, e.g. `["avoid soggy food", "mild spice"]` | Empty list. This covers texture, temperature, smell, messiness, or similar eating-experience guidance without defining sensory enums. |
| `cuisinePreferences` | Array of strings | Empty list. Covers cuisine and cultural food preferences; seasonal or occasion-specific requests belong in weekly input unless a household creates a custom policy. |
| `schoolSchedule` | Structured days, break times, half days, and configured meal slots | Generic starter schema with defaults; the parent supplies or edits the household value. This is user-controlled, not custom. |
| `householdLocation` | `{ country: string, city: string }` | Required before production planning. Lets the planner judge seasonal and standard-grocery availability; country and city are enough for v1. |
| `planPeriod` | `{ startDate: ISO date, endDate: ISO date, timezone: IANA name }` | Required for every plan. Gives the active plan a clear date range and makes relative dates unambiguous. |
| `morningCookingBudgetMinutes` | Optional number | An intelligent workflow default based on the selected slots; the parent may set a real limit. The planner evaluates combined pre-departure work, not recipe times in isolation. |
| `priorNightPrepAllowed` | Boolean | `false` until confirmed, so a viable plan does not assume evening work. When true, the agent may propose soaking, chopping, or batching. |
| `healthPlan` | Structured settings including health focus and one cheat day | Health-focused plan with one enabled cheat day as a suggested baseline. It does not assume household-specific fruit/nut targets. |
| `pantryBaseline` | Array of strings | Empty until supplied. Represents stable grains, pulses, flours, spices, oils, and other staples used as the basis for weekly planning. |
| `weeklyInventory` | Structured current-week ingredient entries plus free-text notes | Empty at the start of the week. Captured in typed or voice form; perishable vegetables/fruits and urgency belong here. |
| `weeklyExceptions` | Structured fields plus an optional natural-language note | Empty. Covers holidays, half days, events, temporary capacity changes, and a requested weekly focus. It expires after the plan’s week. |
| `schoolMealPolicy` | Optional natural-language policy string | Empty. Captures a school’s own no-go rule, e.g. “no biscuits, chips, or junk food.” It replaces the vague “packed-food suitability” and “safety checks” concepts. |
| `trustedRecipeChannels` | Array of channel/chef identifiers or names | Empty list. A configured source is preferred. Lack of an appropriate video does not make a meal ineligible. |

Vegetarian school meals are a workflow-level constant in this first,
India-focused release. They are not stored as a household property yet.

#### Conversational capture of weekly inventory and exceptions

`weeklyInventory` and `weeklyExceptions` are structured *stored values*, but
they are not forms the parent needs to complete. Their primary input surface is
one normal Telegram message or voice note at the start of planning, followed by
a short agent-generated summary for correction.

The intentionally small internal shapes are:

```text
weeklyInventory = {
  items: [
    {
      name: "bottle gourd",
      status: "available" | "low" | "unavailable",
      quantityNote?: "enough for one meal",
      useNote?: "use early"
    }
  ],
  notes: ["curd is already made"],
  sourceText: "original typed message or voice transcript"
}

weeklyExceptions = {
  items: [
    {
      kind: "school_closed" | "half_day" | "schedule_change" |
            "capacity_change" | "occasion" | "plan_request",
      appliesTo?: { day?: "Wed", mealSlots?: ["School lunch"] },
      instruction: "free-text planning fact or request"
    }
  ],
  sourceText: "original typed message or voice transcript"
}
```

This is structured enough to decide which days and meal slots are affected,
while retaining natural language where a rigid schema would be counterproductive.
Quantity, urgency, and meal-slot impact are optional; the agent should not force
the parent to know or provide them.

For example, the parent can trigger the plan with a single typed message or
voice note:

> “Next week Saturday is a holiday, Wednesday is a half day. I have bottle
> gourd, beans, carrots and lots of bananas. Keep it lighter, and I won’t have
> time to prep the night before.”

The workflow transcribes voice when necessary, preserves the original wording,
and produces a proposed patch such as:

- **Inventory:** bottle gourd, beans, carrots, bananas.
- **Exceptions:** Saturday school closed; Wednesday half day; lighter plan
  requested; no prior-night prep available.

Before generating the plan, it replies with a compact confirmation in ordinary
language: “I’ve noted Saturday off, Wednesday half day, a lighter week, and no
night-before prep. I’ll use bottle gourd, beans, carrots, and bananas. Is that
right?” The parent may reply “yes,” correct one point, or add another fact. If
a half-day’s meal-slot impact is not clear, the agent asks only that specific
question rather than presenting a form.

“Nothing special this week” produces an empty `weeklyExceptions` value. A
simple inventory list is enough; the agent combines it with the persistent
pantry baseline.

The same mechanism works after planning. “We’re out of paneer” creates an
inventory patch with `status: unavailable` and can start a local replacement
request. “Friday is now a holiday” adds a schedule exception, but does not
change the plan unless the parent also asks to recreate the remaining days.
The parent never edits internal property objects directly;
the conversation is the input, the summary is the review surface, and the
stored values are the planner’s working state.

These values are **week-scoped conversation state**. During the active week,
each relevant Telegram message may cause the agent to derive and apply a patch
to `weeklyInventory`, `weeklyExceptions`, or both as a side effect of answering
the parent. The patch is the state the next response and any subsequent plan
revision use. Each patch retains its source message/transcript and timestamp,
so the parent can correct the agent in ordinary language. The agent should
apply unambiguous, low-risk facts directly and ask a short question only when
an interpretation would materially change the plan. Week-scoped state expires
with that plan and never becomes persistent household context unless the
parent explicitly promotes it.

#### Custom properties

A custom property is the escape hatch for meaningful household rules we cannot
or should not turn into platform schema prematurely. It contains:

- a short user-controlled label;
- a plain-language policy or a simple string list;
- an optional scope: persistent household rule or current-week rule; and
- an explicit status: active, edited, or removed by the parent.

Custom-property values are **data, not executable instructions**. The planner
may use them only as meal-planning policy, after applying platform rules and
hard dietary exclusions. It must not allow custom text to change system
behavior, access data, invoke tools, or override platform or hard dietary
constraints. When a policy is unclear, conflicts with another rule, or cannot be followed, the
agent should surface the interpretation or ask a concise question rather than
silently guess. This separation also gives us a clear input-validation and
evaluation boundary for the eventual LLM implementation.

For every relevant custom policy, the proposed plan records whether it is
`satisfied`, carries a labelled `trade-off`, or `needs-clarification`. The plan
must not claim certainty when the policy cannot be interpreted confidently.

Initial custom properties for this household, based on the discovery so far:

| Custom property | Example value | Scope |
| --- | --- | --- |
| `Snack policy` | “School snacks should usually be dry, quick to pack, and not cooked that morning. Roasted lentils or sprouts are good examples.” | Persistent |
| `Ingredient naming` | “Use ingredient names localized to India and always write them in singular form.” | Persistent |
| `Relevant variety` | “Repeat a dish at most twice in the plan, and only when it is marked as a favourite.” | Persistent |
| `Nutrition target` | “Pack fruit in a snack at least three to four times each week.” | Persistent |
| `Nutrition target` | “Include nuts or dry fruits regularly.” | Persistent |
| `Weekly season/occasion rule` | “Use monsoon-friendly vegetables this week.” | Current week |

The initial household configuration should start with Snack policy, Ingredient
naming, Relevant variety, and the two Nutrition-target rules above. Equipment
and packing constraints remain deterministic operating rules rather than
persistent policies. The seasonal
example shows the mechanism’s range without requiring it on day one.

#### First-order workflow entities and transaction records

Some important planning inputs are neither generic nor custom properties:

- **Previous active plans** are first-order workflow entities. The planner
  uses them for default cross-week variety; no special property is needed to
  enable that behaviour.
- **Household dish repertoire** is a derived/workflow-managed entity, populated
  by active plans and later explicit learning. It is not a custom property.
- **Meal revision comments and replacement requests** are transactional
  records. They drive the current revision but do not enter lasting context by
  themselves. A later learning flow may offer to promote a pattern into a
  generic-property value or a custom property with parent approval.

#### Source and ownership

Property source remains useful, but is separate from generic/custom:

- **Pre-configured:** platform defaults and workflow constants, such as the
  vegetarian school-meal policy and generic property defaults.
- **User-controlled:** the parent supplies, selects, edits, or removes the
  household value for a generic property or creates/edits a custom property.
- **Feedback-captured:** a plan-change record. It is history first, and is
  promoted into configuration only through an explicit parent action.

## 6. Planning policy

The agent creates a five-slot plan for every configured school day. It must:

- Respect all hard dietary, allergy, and vegetarian constraints.
- Treat school meal policies as guidance rather than hard prohibitions. It
  should try to comply, but may make the least-bad feasible choice and label
  the trade-off when necessary.
- Favor available vegetables and perishable ingredients.
- Avoid proposing a shopping-dependent meal by default.
- May suggest a short list of additions only when they are standard groceries
  or normally available in the current season in the household's country and
  city. Every such item must be visibly identified in the plan as an
  easy-buy addition, not treated as already available.
- Apply healthy-eating preferences as best-effort guidance rather than fail the
  plan when they cannot all be met.
- Apply generic properties and measurable operating limits as rules. For every
  relevant custom policy, record a concise satisfied, trade-off, or
  needs-clarification outcome; consequential ambiguity or a conflict with a
  hard constraint earns one concise question.
- Treat a configured cheat day as an intentional exception to ordinary health
  preferences.
- Consider meal-slot suitability: packed school food must suit packing and the
  relevant break. Packed school food is dry by default, especially snacks;
  avoid wet, messy, or impractical packed dishes unless the profile explicitly
  permits them.
- Treat snacks as pre-prepared or quick, dry items by default—for example,
  fruit, nuts, roasted lentils, roasted sprouts, or another configured option.
  Do not propose a substantial cooked snack such as a sandwich unless it is
  explicitly suitable, very quick, and fits the morning preparation budget.
- Treat school lunch and home lunch as fresh-cooked by default. Home lunch is
  normally cooked after the child leaves. Breakfast is preferably fresh-cooked
  but must yield to the available morning preparation capacity.
- Assess the *combined* pre-departure workload: breakfast, packed school
  lunch, and any cooked snack compete for the same limited morning window.
  A plan is not feasible merely because every individual meal has a short
  cooking time. The agent should minimize same-morning cooked items and may
  give optional prior-night preparation advice to make a selected plan viable.
- Do not create more than two meals requiring prior-night preparation on one
  day. This is a planning limit even when prior-night prep is allowed.
- Prefer variety across the week and relative to the immediately previous
  plan, while preserving familiar foods configured in the profile. The agent
  should avoid repeating the same named dish or close variants without a
  reason. Unless the parent supplies a quantity or explicitly allows reuse,
  treat each fresh vegetable other than onion, tomato, and potato as sufficient
  for one meal only; do not use it as the base of multiple meals in the week.
- Compose home lunch as staple (plain rice or chapati) + one vegetable
  curry/subzi + one protein dish (dal, kadhi, sambar, or another lentil-based
  dish). A flavored-rice meal such as pulao or tomato rice is an exception and
  may stand alone without that three-part combination.
- Use unfamiliar dishes only when `allowNewFoods` is true. They need not be
  visibly marked as new.
- Retain structured decision rationale for every cell and expose concise
  labels—not an explanatory essay—for material trade-offs such as an easy-buy
  addition, a prior-night requirement, or an unusually demanding morning.

The agent may offer optional prior-night preparation advice (for example,
chopping vegetables or soaking ingredients) when it reduces morning workload.
It must distinguish a suggested convenience from preparation that is required
for the chosen plan to be workable.

### 6.1 Stored plan and meal data

The v1 plan keeps its decision data even if the initial grid exposes only a
small portion of it. This both makes later rationale UX possible and makes the
planner's choices inspectable. Each plan stores its period, household location,
timezone, version, pending-feedback state, and outcomes for relevant custom
policies, including their affected cells and rationale. Each meal cell stores:

- meal name and slot;
- preparation label and any required or optional prior-night prep;
- principal ingredients and the inventory items it intends to use;
- any easy-buy additions, separately labelled from inventory;
- recipe-video result for lunch slots, including an explicit “no suitable video
  found” result where applicable; and
- structured planning rationale and trade-off labels.

Structured rationale is required for planning quality, but its presentation is
an evolving UX decision. The initial grid should reveal only the labels useful
for a quick scan and let the parent open details on demand.

## 7. Weekly planning flow

1. The parent initiates planning, normally on Sunday.
2. The agent briefly asks for week-specific exceptions and available
   ingredients, using existing profile information rather than re-asking for
   persistent preferences.
3. The agent proposes a complete draft for the configured school days and
   meal slots.
4. The parent reviews the draft as a weekly grid and leaves natural-language
   feedback on individual meals or a whole day. “Give feedback” is more
   accurate than a direct replacement action: the agent, not the parent,
   proposes the resulting changes.
5. Feedback remains pending until the parent asks for an updated plan. The
   current plan stays visible with a pending-changes indicator.
6. When asked, the agent processes the feedback together and returns a
   complete revised grid. That revised grid immediately replaces the active
   plan; no separate finalization or approval action is required.
7. A plan with no pending feedback is treated as final for its school week and
   remains accessible on demand.

The initial planning conversation retains context for its duration. Persistent
profile changes must be explicit, reviewable updates; v1 does not infer them
from a single plan or meal change.

## 8. Active-plan and review requirements

Telegram is the conversational surface: starting a plan, supplying weekly
context, answering targeted clarification questions, and asking the agent to
process feedback. The Mini App is the visual plan surface: reviewing the
weekly grid, opening meal details, and recording per-cell or per-day feedback.
Neither surface needs to reproduce every action in v1.

The active plan must look and behave like a compact fridge-board table:

| Meal slot | Mon | Tue | Wed | Thu | Fri | Sat |
| --- | --- | --- | --- | --- | --- | --- |
| Breakfast | Meal | Meal | Meal | Meal | Meal | Meal |
| Snack 1 | Meal | Meal | Meal | Meal | Meal | Meal |
| Snack 2 | Meal | Meal | Meal | Meal | Meal | Meal |
| School lunch | Meal | Meal | Meal | Meal | Meal | Meal |
| Home lunch | Meal | Meal | Meal | Meal | Meal | Meal |

It must be practical to scan and use from a phone. At minimum, each meal cell
must support:

- Seeing the proposed meal at a glance.
- Opening sufficient detail to understand ingredients and any optional prep
  note.
- Giving a natural-language (typed or voice) feedback request for a meal or
  the day; the request becomes a pending change, not a direct user replacement.
- Seeing a pending-changes indicator while feedback exists.
- Opening the pre-fetched recipe video result for school lunch or home lunch;
  other slots do not require video support in v1.

The primary experience must preserve a visual weekly overview. A chat channel
may start the workflow and interpret natural-language feedback, but it does
not by itself satisfy the plan-review requirement unless it provides an
equally usable per-cell review experience.

### 8.1 Conversational routing in a multi-workflow chat

> Telegram has no real threading, and Kipp hosts several workflows (idea
> pipeline, calendar, meal planning) in one chat, so parallel pending
> prompts are normal. Plain-text routing must therefore be deterministic:
> never route unaddressed text by LLM intent classification at the ingress,
> and never assume the parent works through one workflow at a time.
>
> The contract:
>
> - Reply-to a specific bot message resolves exactly (`botMessageId`); it
>   is the disambiguator when several prompts pend.
> - Unaddressed plain text resolves the newest pending prompt in the chat,
>   regardless of which workflow owns it (the router's per-chat
>   interactions table is the stack of open interactions; newest wins).
>   While another workflow's prompt is pending, plain text belongs to it.
> - Each workflow keeps a readily-reachable explicit intent switch — an
>   inline button that, when tapped, registers that workflow's prompt as
>   the newest pending interaction, so the next plain-text message maps to
>   it immediately. The parent never waits for another workflow's prompt to
>   expire.
> - Conversational prompts are short-lived (interaction lifetime, 15
>   minutes); the switch affordance stays available for the whole relevant
>   period (long button, short prompt). Plain text with no pending match
>   may fall through to the meal-planning workflow's live session when one
>   exists — the single-workflow convenience — and never competes with a
>   real pending prompt.
>
> Iteration 1 realizes the switch as the `[Give feedback]` button on the
> plan message, with prompt lifetimes of 15 minutes; full routing
> semantics live in the iteration-1 plan (§6 plain-text routing contract).
> For iteration 2, the Mini App must preserve the same contract: keep the
> explicit switch reachable (e.g., from the home view), and deliver
> per-cell feedback as structured submissions (`feedback-submit`) that
> bypass text routing entirely — the parent's feedback never competes with
> another workflow's pending prompt.

## 9. Recipe-video behavior

Recipe discovery is attempted ahead of time for school lunch and home lunch in
an active plan. It is not required for breakfast or snack cells in v1.

- Prefer video recipes, initially prioritizing YouTube.
- Prefer the household’s configured chefs and channels.
- If no appropriate preferred-source recipe is available, the agent may use a
  suitable reputable fallback. If it still cannot find one, retain the meal
  and record that no suitable video was found.
- Suitability includes the meal, dietary/allergy restrictions, vegetarian
  policy, cuisine preferences, and packed-school context where relevant.
- Do not present a generic popularity ranking as though it were a meal-specific
  recommendation.

## 10. Midweek change behavior

The parent can request a change through the accessible plan or conversational
input, for example because an ingredient is unavailable or a school day has
changed.

- Treat the existing accepted cells as implicitly approved. Default to the
  smallest change that addresses the feedback and preserve the rest of the
  week and its implied preparation plan.
- A feedback request may explicitly widen scope, such as “this whole day looks
  untenable.” The agent may then replan that day, and may make a broader
  optimization only when there is a clear opportunity consistent with the
  user's comments.
- Collect requested feedback as pending changes and process it together when
  the parent asks for an updated plan; return the full revised grid.
- Explain any required easy-to-obtain addition or consequential change through
  plan labels.
- A new fact such as “tomorrow is a holiday” updates week state but does not
  itself change the plan. The parent must ask to recreate the remaining plan
  if they want the agent to use the resulting unused food or preparation.
- When a requested change appears to conflict with a hard dietary constraint,
  seek clarification in Telegram before creating a revision.

## 11. Product-quality requirements

- **Configurable:** no fixed assumption about a child’s meal count, school
  days, diet, cuisine, or household schedule.
- **Safe for the household:** never suggest a meal that violates a stored hard
  dietary or allergy constraint.
- **Understandable:** distinguish available ingredients from suggested
  additions and distinguish optional prep from required preparation.
- **Low effort:** ask only for missing, week-relevant information and make the
  final plan immediately scannable; accept voice input wherever a concise
  spoken answer is easier than typing.
- **Morning-feasible:** keep the combined before-school cooking workload within
  the household's configured capacity, not just the individual cooking times.
- **Varied:** avoid unintentional repetition across the current and previous
  week, except for configured favorites or parent-requested repeats.
- **Editable:** enable meal-level feedback and local revisions without erasing
  an active week.
- **Accessible:** keep the active plan easy to retrieve throughout the week.
- **Measurable:** track the number of feedback comments attached to each plan
  that becomes active; this is the first proxy for planning quality and
  acceptance.

## 12. Open product decisions

The following decisions are intentionally not made by this specification:

1. The exact persistent-profile editing experience.
2. The recipe-source trust, fallback, and ranking policy in enough detail to
   implement consistently.
3. The exact configured measure of morning preparation capacity and how the
   plan should explain it.
4. The later design for refrigerator-photo input, including its inventory
   confidence and review rules.
5. The later definition of shopping support.
