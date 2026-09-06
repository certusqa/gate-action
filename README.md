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

Your `playwright.config` needs the JSON reporter:

```js
reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
```

## The four verdicts

| Verdict | When | Enforce mode |
|---|---|---|
| `CLEAR_TO_DEPLOY` | Every test passed first time and no failure media is on disk | passes |
| `REVIEW_ARTIFACTS` | A test passed only on retry, or failure screenshots/videos exist | passes unless `strict: true` |
| `BLOCK_DEPLOY` | At least one test failed after its retries | fails the job |
| `INSUFFICIENT_EVIDENCE` | The report is missing, unreadable, or has no tests | fails the job |

The last row is the one most gates get wrong. A missing report means the tests did not run, and
a gate that passes then is not a gate.

## What you get

```
certusqa-gate/
├── gate.json          verdict, counts, failures, media, mode
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

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `results` | `test-results/results.json` | Playwright JSON reporter output |
| `media-dir` | `test-results` | Scanned for `png`, `webm`, `zip` failure media |
| `mode` | `report-only` | `report-only` never fails the job; `enforce` fails on `BLOCK_DEPLOY` and `INSUFFICIENT_EVIDENCE` |
| `strict` | `false` | In enforce mode, also fail on `REVIEW_ARTIFACTS` |
| `output-dir` | `certusqa-gate` | Where the evidence is written |
| `artifact-name` | `certusqa-gate` | Workflow artifact name; empty string skips the upload |
| `working-directory` | `.` | Base for the paths above |

## Outputs

`verdict`, `report-status`, `passed`, `failed`, `flaky`, `skipped`, `output-dir`.

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
- It does not send anything anywhere. No network calls. Read the source; it is one file.

## Example

See [`examples/quickstart.yml`](examples/quickstart.yml).

## Self-test

This repository runs the action on its own fixtures in CI, one job per verdict, and checks the
outputs. If the badge is green, the four rows in the table above are true today.
