# CertusQA Gate

A pre-deploy verdict you can prove, from the Playwright suite you already have.

Add one step after your tests. On every run you get one of four verdicts, a Proof Artifact per
failure, a step summary, and outputs you can gate on. It starts in **report-only**: it records,
it never blocks, until you switch it.

```yaml
- uses: certusqa/gate-action@v1
  with:
    results: test-results/results.json   # your Playwright JSON reporter output
    mode: report-only                    # switch to enforce when you trust it
```

The action reads Playwright's JSON reporter. On Playwright 1.63 or newer, add it on the command
line and leave your config alone:

```yaml
- run: npx playwright test --add-reporter json
  env:
    PLAYWRIGHT_JSON_OUTPUT_FILE: test-results/results.json
```

`--add-reporter` appends to the reporters your config already declares instead of replacing
them. On older Playwright, declare the reporter in `playwright.config`:

```js
reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
```

If your config already has a JSON reporter, keep it and point `results` at its `outputFile`;
the environment variable above overrides every JSON reporter's output path when set.

## The four verdicts

| Verdict | When | Enforce mode |
|---|---|---|
| `CLEAR_TO_DEPLOY` | Every test passed first time, and no test wrote a snapshot baseline instead of comparing one | passes |
| `REVIEW_ARTIFACTS` | A test passed only on retry, or a test compared nothing | passes unless `strict: true` |
| `BLOCK_DEPLOY` | At least one test failed after its retries | fails the job |
| `INSUFFICIENT_EVIDENCE` | The report is missing, unreadable, or has no tests | fails the job |

The last row is the one most gates get wrong. A missing report means the tests did not run, and
a gate that passes then is not a gate.

**Recorded media does not make a run reviewable.** Earlier versions returned `REVIEW_ARTIFACTS`
when any screenshot, video or trace existed anywhere under the media directory — including
leftovers from a previous run. Since Playwright made `video: 'on'` ordinary, that meant every green
run carried a `.webm` and every green run asked for review; under `strict: true` it blocked the
deploy. Only media that a **failed or flaky** result actually references counts now, read from
`attachments[].path` in the report. The rest is listed as `recordedMedia` and named in the summary
as recorded, not failure evidence.

### "Your CI was green, and these tests compared nothing"

Playwright's `updateSnapshots` defaults to `missing`, and from 1.64 a screenshot assertion with no
baseline on disk **passes**: it writes the baseline and moves on. Nothing annotates it, so a suite
can report all-green while some of its tests compared nothing at all.

The gate names them. A passing test carrying a `*-actual.*` attachment wrote a baseline rather than
comparing one — Playwright attaches expected/actual on a comparison *failure*, so on a pass it is
the write. They appear as `baselineWritten` in `gate.json`, by name in the summary, and the run is
`REVIEW_ARTIFACTS` rather than `CLEAR_TO_DEPLOY`. It does not block: it is not a failure, but a
green tick overstates it.

Commit the baselines and re-run, or those tests keep passing against their own output.

### A CLEAR says what it cleared

If projects are configured but not run — a `default: false` project, or a `--project` filter — the
summary says so: *"Configured, not run: firefox, webkit — this verdict covers chromium only."*
`projectsConfigured`, `projectsRun` and `projectsNotRun` are in `gate.json`. This is
informational and never changes the verdict; choosing not to run a browser is a choice, not a
defect. Reports from before Playwright 1.64 carry no `filteredProjects` field, and absent is
reported as unknown rather than as "nothing ran".

## What you get

```
certusqa-gate/
├── gate.json          verdict, counts, failures, media, mode, run scope
├── summary.md         the same summary that lands on the run page
└── proof/
    └── pa_unjudged_3f2a9c1e.json   one per failed or flaky test
```

Uploaded as a workflow artifact (`artifact-name`, default `certusqa-gate`) and written to the
job summary. Every Proof Artifact has the same shape as the ones the CertusQA engine emits:
`classification`, `rootCause`, `remediation`, `evidence`. Here they are honestly marked
`failKind: "unjudged"` and `confidence: "none"`: this action records the failure; deciding
whether it is a regression, a flake or a test defect is the CertusQA judge's job, and the judge
is the hosted part.

## A free test-isolation check

Shuffle the order and let the gate tell you what broke:

```yaml
- run: npx playwright test --shuffle $GITHUB_RUN_ID --reporter=json
- uses: certusqa/gate-action@v1
```

A test that only passes in its usual position is coupled to another test, and that is neither a
regression nor a flake — it is a defect in the suite that will surface later as an unreproducible
failure. The gate prints the seed it saw (`shuffleSeed` in `gate.json`, and in the summary) so a
shuffled run can be reproduced exactly: re-run with the same `--shuffle <seed>`.

The seed is read from the report's own metadata. The action never copies the runner's `argv` into
any output, because it holds absolute paths from the machine that ran the tests.

Do not shuffle the run you gate a release on. Shuffle a separate job.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `results` | `test-results/results.json` | Playwright JSON reporter output |
| `media-dir` | `test-results` | Scanned for `png`, `webp`, `webm`, `zip` failure media |
| `mode` | `report-only` | `report-only` never fails the job; `enforce` fails on `BLOCK_DEPLOY` and `INSUFFICIENT_EVIDENCE` |
| `strict` | `false` | In enforce mode, also fail on `REVIEW_ARTIFACTS` |
| `output-dir` | `certusqa-gate` | Where the evidence is written |
| `artifact-name` | `certusqa-gate` | Workflow artifact name; empty string skips the upload |
| `working-directory` | `.` | Base for the paths above |
| `api-key` | *(empty)* | Optional CertusQA platform key (`cqa_live_…`, from a secret). When set, the run is signed and uploaded after the evidence is written. Unset means no network call at all |
| `api-url` | `https://app.certusqa.com/api/v1/runs` | Only change for a self-hosted or test platform |

## Outputs

`verdict`, `report-status`, `passed`, `failed`, `flaky`, `skipped`, `output-dir`, and — when `api-key` is set and the upload succeeded — `run-id` and `run-url`.

```yaml
- uses: certusqa/gate-action@v1
  id: gate
- run: echo "verdict=${{ steps.gate.outputs.verdict }} failed=${{ steps.gate.outputs.failed }}"
```

## Order of operations, on purpose

1. Compute the verdict and write the evidence. This step never fails.
2. Upload the evidence as an artifact.
3. Enforce. Only this step can fail the job, and by then the evidence is already saved.

## What this action is not

- It does not run your tests. Put it after `npx playwright test`, with `if: always()` so it
  sees the failing run too.
- It does not decide *why* a test failed. It records; the judge classifies. That is the line
  between this free action and the CertusQA service.
- It does not send anything anywhere **unless you set `api-key`**. Without it there is no network
  call; with it, exactly one POST of `gate.json` and `proof/*.json` to the platform, nothing else.
  Read the source; it is three small files.

## Uploading to the CertusQA platform (optional)

```yaml
- uses: certusqa/gate-action@v1
  with:
    api-key: ${{ secrets.CERTUSQA_API_KEY }}
```

With a key, the action signs the run and uploads it after the evidence is written: history,
trends and the judge's classification then live on the platform. What is sent is exactly
`gate.json` plus `proof/*.json` — test titles, file paths relative to your repo, sanitised error
text, attempt statuses — with the GitHub run, commit and PR number as the reference. No source,
no screenshots, no secrets.

The secret never leaves the runner in the clear beyond the `Authorization` header to the
platform: the request is signed with a key derived from it (HKDF-SHA256), and the platform
stores only a hash. An upload that is refused or fails is a **warning**, never a failed step;
the verdict and the files are the product, the upload is a copy. Idempotent per workflow run
and attempt, so a re-run does not double-count.

## Example

See [`examples/quickstart.yml`](examples/quickstart.yml).

## Self-test

This repository runs the action on its own fixtures in CI, one job per verdict, and checks the
outputs. If the badge is green, the four rows in the table above are true today.

## Versioning

`certusqa/gate-action@v1` is a moving tag that always points at the latest `v1.x.y` release, so a
workflow pinned to `@v1` gets fixes without edits and never a breaking change. Pin to a full tag
(`@v1.0.0`) or a commit SHA if you want nothing to move.

## License

MIT. See [LICENSE](LICENSE). The action is a thin client; the CertusQA engine and platform are
separate, proprietary services.
