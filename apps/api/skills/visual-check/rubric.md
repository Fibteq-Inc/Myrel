# Visual check rubric

## Stance

Assume there are problems and look for them before you form an overall opinion. Evaluators that start from "looks good" find a problem and then talk themselves out of it: if you noticed something, it goes in `blocking` or `advice`, never nowhere. Judge what is on the screen, not the effort, the amount of code or the coder's explanation. A finding without a screenshot is not a finding.

## Scores (whole numbers, 1–10)

| Score | Bar | Look at |
|---|---|---|
| `functionality` | **≥ 6 to pass** | Each screen shows what the brief asked for. The states it needs exist (empty, loading, error, long content). Nothing is broken at any width or theme. Controls look like controls and can be reached. Text is readable. |
| `craft` | **≥ 6 to pass** | Alignment, consistent spacing rhythm, sizes, corner radii and colours; a clear type hierarchy; contrast; the phone layout is designed, not squeezed, and the desktop layout is not stretched; dark theme is as finished as light (no unreadable text, no light-only images); images sharp and not distorted; consistent with the rest of the product. |
| `design` | advisory | Hierarchy and focus: what the eye lands on first, whether the main action is obvious, whether the screen feels like one coherent piece. |
| `originality` | advisory | Deliberate choices rather than template defaults (the generic gradient hero, the same card grid every app has). Only judge it when the brief asks for a distinctive look. |

Anchors: **9–10** ready to ship, would pass a strict design review; **7–8** good, minor polish left; **5–6** problems a user would notice; **3–4** parts clearly broken; **1–2** unusable. The bar is low on purpose while the rubric is calibrated against people's own judgement; `design` and `originality` do not block yet.

## What is blocking

- The screen does not do what the brief asked, or an acceptance criterion is not met.
- Broken at one of the widths or themes: overlapping or cut-off content, unreadable text, a control hidden or unreachable, a broken image, a layout that falls apart.
- Something a user would notice at once as a bug: misalignment that looks broken, wrong images, a dark theme with light-theme leftovers.
- A regression: the base branch looked right and this one does not.

Everything else (taste, polish, nice-to-haves, problems that predate the change) is `advice`. Keep advice to the few points that matter most.

## Games

In addition: the HUD is readable at phone width and does not cover the play area; the player, hazards and collectibles are easy to tell apart; actions have visible feedback; the art style is consistent across screens; touch controls are big enough; the start, win and game-over screens exist and fit the screen. Check the frames: motion should look intentional, not jittery or stuck.

## verdict.json

```json
{
  "verdict": "fail",
  "round": 1,
  "evaluator": { "cli": "codex", "model": "gpt-5.5", "effort": "high", "probeAnswer": "K7FQX" },
  "scores": { "functionality": 4, "craft": 6, "design": 7, "originality": 5 },
  "acceptance": [
    { "criterion": "Pricing shows three plans", "met": true, "evidence": "pricing-1440-light.png" },
    { "criterion": "The main button is visible without scrolling on a phone", "met": false, "evidence": "pricing-390-dark.png" }
  ],
  "blocking": [
    {
      "id": "cta-hidden",
      "screen": "pricing@390-dark",
      "evidence": "pricing-390-dark.png",
      "problem": "The Choose Pro button sits under the bottom navigation bar.",
      "expected": "The button is fully visible above the bar without scrolling."
    }
  ],
  "dismissed": [
    { "id": "covered-control", "screen": "pricing", "reason": "The cookie banner covers the footer link; the banner is closed in real use and is out of scope." }
  ],
  "advice": ["The three cards use three different gaps (16, 20 and 24 px)."]
}
```

- `verdict`: `pass`, `fail`, or `deterministic_only` when no model that reads images took part (the result then says the look was not judged).
- `evaluator`: the CLI, model and effort that judged, and the probe code you read. Say what you really are; the person compares models by this.
- `blocking[].screen`: `<screen>@<width>-<theme>` as in `report.json`; `evidence`: a file in the output folder. A deterministic finding you agree with may be listed as is (`id` from the report) or left out: `verdict.mjs` adds every open one itself.
- `dismissed`: deterministic findings you checked and found false, by `id` and `screen` (a bare screen name covers all its widths and themes), each with a reason.
