# Adding a rule or a scenario

A rule is one check that 1518 makes on a request. A scenario is one decision that the tester picks, for example "approve" or "reject". This page shows how to add each one, with a worked example.

## The evidence rule

Every rule must cite real evidence. Real evidence is one of these:

- A message id and date from real sandbox traffic, for example `real sandbox traffic (16 Nov 2026)`.
- A page of an NHA document, with its version.
- A statement from NHA in writing, with its date.

If you have no evidence, you can still add the rule, but you must write "predicted" in its `source`. A guess must never read as a fact.

## Worked example: a claim with the admission after the discharge

On 16 November 2026, 1518 refused a claim with this text: "Admission date cannot be after the discharge date." The code was `PAYR-1357`. The HIMS sent a same-day discharge as a bare date, `2026-11-16`, so the discharge read as midnight, before the admission in the morning. The same claim with a discharge time was accepted. This example shows how that rule was added.

### Step 1: Write the rule

Open `src/engine/rules.js`. Add an object to the `RULES` list. The position in the list sets the order of the checks. The simulator reports the first rule that fails, as 1518 answers one error at a time.

```js
{
  id: 'admission-after-discharge', code: 'PAYR-1357', actions: [CLAIM], observed: [CLAIM],
  source: 'fixture error-payr-1357-admission-date-cannot-be-after-the-disch (16 Nov 2026); accepted once the discharge carried a time',
  check(ctx) {
    const d = B.dates(ctx.bundle);
    if (d.admissionMs != null && d.dischargeMs != null && d.admissionMs > d.dischargeMs)
      return [{ path: 'Claim.supportingInfo[DSDE]', message: 'Admission date cannot be after the discharge date. Hence request will not be processed. Please correct the data and try again.' }];
    return [];
  },
},
```

The fields are:

- `id`: a short name for the rule.
- `code`: the error code that 1518 sends.
- `actions`: the calls the simulator applies the rule to.
- `observed`: the calls on which 1518 was seen to apply it. If `actions` is wider than `observed`, add a comment that says why. The wider use is a prediction.
- `source`: the evidence.
- `check(ctx)`: returns a list of failures. Each failure has a `path` and the exact `message` that 1518 sent. Copy the message word for word.

If the rule needs a field that `src/engine/bundle.js` does not read yet, add a reader function there.

### Step 2: Write the test

Open `test/engine.rules.test.js`. Add one test. The test sends a bundle that breaks the rule and expects the code. Then it sends the same bundle, fixed, and expects no code.

```js
test('PAYR-1357 same-day discharge sent as a bare date', () => {
  fresh();
  const bad = H.bundle({ use: 'claim', admitted: '2026-11-16T09:00:00+05:30', discharged: '2026-11-16' });
  assert.deepStrictEqual(codes(engine.validate('claim/submit', bad)), ['PAYR-1357']);
  const ok = H.bundle({ use: 'claim', admitted: '2026-11-16T09:00:00+05:30', discharged: '2026-11-16T15:00:00' });
  assert.deepStrictEqual(codes(engine.validate('claim/submit', ok)), []);
});
```

`test/engine.helpers.js` builds the bundles. If the helper cannot set the field you need, add an option to it.

### Step 3: Add the fixture

If you have the real request and the real answer, add them in a new folder, for example `fixtures/error-payr-1357-admission-date-cannot-be-after-the-disch/`. The folder holds:

- `request.json`: the request that the HIMS sent.
- `response.json`: the answer from 1518.
- `meta.json`: the message ids, the dates, the outcome and what you scrubbed.

Before you commit a fixture, replace all personal data and all hospital data with fakes. This includes names, phone numbers, ABHA, Aadhaar and HPR numbers, addresses, case numbers, bill numbers, and the ids of the hospital. Use the fake ids in the README (`1000000001@hcx`, `IN0000000000`, `10001`). Keep the NHA codes, the package codes and the sandbox member `SBXSTG269`. `test/engine.fixtures.test.js` then runs the rules on your real request and compares the result with the real answer.

### Step 4: Run the tests

```sh
npm test
```

All tests must pass. The test `every rule names its source` fails if the new rule has no `source`.

## Adding a scenario

1. Add an entry to `SCENARIOS` in `src/engine/scenarios.js`. Give it an `id`, a short `label` and a one-sentence `description`. If the scenario expects a certain request, add an `expect` function. It returns a note when the request does not match. It never refuses the request.
2. Add the decision for the new id in `src/engine/index.js`, where the engine reads the scenario.
3. Add the new id to the list in the first test of `test/engine.scenarios.test.js`, then add a test that runs the scenario from start to end.
4. Run `npm test`.

The new scenario then appears in `GET /mock/config`, on the page, and in the playground.
