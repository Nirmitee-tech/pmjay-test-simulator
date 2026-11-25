# PMJAY Test Simulator

PMJAY Test Simulator is a local stand-in for three NHA services: the NHCX exchange sandbox, the PMJAY payer `1518@hcx`, and the NHA dummy payer `1000003538@hcx`. A hospital system (HIMS) talks to it with the same calls it uses against NHA. You change only the addresses in the HIMS configuration. Nothing in the simulator calls NHA.

Nirmitee Tech built it and maintains it.

## Why it exists

NHA's sandbox is slow and it goes down. A person at the State Health Agency (SHA) decides each pre-auth and claim by hand, so one scenario can take days. With the simulator, the same scenario takes minutes, and it gives the same answer every time you run it.

## Quick start in 5 minutes

You need Node.js 20 or later. The project has no npm dependencies. If `openssl` is on the path, the simulator uses it to make a self-signed payer certificate. Without it, the simulator uses a bare public key.

1. Get the code and run the tests:

       git clone <this repository> pmjay-test-simulator
       cd pmjay-test-simulator
       npm test

2. Start the simulator. It listens on port 9300 by default:

       PMJAY_CALLBACK_BASE=http://localhost:8081 ./run.sh

   At first start, it makes a key pair and a self-signed certificate for `1518@hcx` in `data/`. The `data/` folder is not in git.

3. Point the HIMS at the simulator. Replace `<sim>` with the address of the simulator as the HIMS sees it, for example `http://localhost:9300`. Your HIMS has its own names for these six addresses.

   | Address in the HIMS | Real NHA service | Value for the simulator |
   |---|---|---|
   | Session (token) URL | ABDM gateway sessions | `<sim>/gateway/v0.5/sessions` |
   | Participant registry base | NHCX participant service | `<sim>/participanthcxservice` |
   | Use-case base (`/v1/...` calls) | NHCX exchange | `<sim>/hcx` |
   | Dummy payer base | NHA dummy payer | `<sim>/dummyhcxpayer` |
   | Presence (biometric) base | ABHA biometric service | `<sim>/abha/biometric` |
   | Face authentication base | ABDM proxy for face authentication | `<sim>/abdmproxy/abha/biometric` |

   The session call accepts any client id and secret that is not empty. If you set `PMJAY_CLIENT_ID` and `PMJAY_CLIENT_SECRET`, it accepts only those.

4. Give the simulator the public certificate of the HIMS, so that it can encrypt the callbacks. Do one of these two steps:
   - Set `PMJAY_HIMS_CERT` to the PEM file of the certificate, then restart.
   - Let the HIMS call `participant/update` with its certificate. Most HIMS builds do this at start.

5. Pick a scenario, then send a request from the HIMS:

       curl -X POST localhost:9300/mock/scenario -H 'content-type: application/json' -d '{"scenario":"approve"}'

6. Open `http://localhost:9300/` in a browser. The page shows each message, its answer, and the callback that went to the HIMS.

## Configuration

All configuration is in environment variables. `src/server/config.js` reads them. `examples/hims.env.example` has a copy that you can edit.

| Variable | Default | Meaning |
|---|---|---|
| `PMJAY_PORT` | `9300` | The port. |
| `PMJAY_CALLBACK_BASE` | `http://localhost:8081` | Base address of the HIMS. Callbacks go to `<base>/v1/<entity>/on_*`. |
| `PMJAY_HIMS_CERT` | empty | PEM file with the public certificate of the HIMS. A certificate that the HIMS sends through `participant/update` replaces it. |
| `PMJAY_PROVIDER_PARTICIPANT_CODE` | `1000000001@hcx` | The NHCX participant code of the HIMS. |
| `PMJAY_PROVIDER_REGISTRY_ID` | `IN0000000000` | The facility registry id. 1518 puts it on claim, cover and payment answers. |
| `PMJAY_PROVIDER_ID` | `10001` | The PMJAY hospital id. 1518 puts it on pre-auth answers. |
| `PMJAY_PROVIDER_NAME` | `TEST HOSPITAL` | The hospital name on answers. |
| `PMJAY_POLICIES` | empty | Optional JSON file with registry policy lists. See `examples/policies.example.json`. |
| `PMJAY_POLICY_MEMBERS` | `SBXSTG269` | Member ids that `get/policies` finds a policy for. `SBXSTG269` is the NHA sandbox test member. |
| `PMJAY_POLICY_HOLDERS` | empty | More matches, as `MobileNo:<n>,AbhaNumber:<n>`. |
| `PMJAY_DELAY_MS` | `1500` | The default delay before a callback. |
| `PMJAY_DECISION_DELAY_MS` | empty | In scenario `auto`, a pre-auth that needs review waits for the desk. A number approves it that many milliseconds after the request. |
| `PMJAY_STATUS_DELAY_MS` | `1000` | The gap between the `/v1/status` answer and the `on_status` callback. |
| `PMJAY_DATA_DIR` | `data/` | Keys and the message log. |

The default provider ids are fake. Set your own ids if the HIMS checks them.

## Scenarios

A scenario tells the simulated payer what to decide. You set it in one of two ways:

- For all requests: `POST /mock/scenario {"scenario":"<id>"}`.
- For one request: the header `X-Mock-Scenario: <id>`.

The scenario `auto` is the default. In `auto`, the simulator applies every rule that 1518 was seen to apply. If a rule fails, the HIMS gets the same error code and text that 1518 sent. If no rule fails, the request is approved. The other scenarios are `approve`, `partial`, `query`, `reject`, `pending`, `cancel`, `enhancement`, `implant`, `newborn`, `lama`, `dama`, `death-before`, `death-after`, `two-packages`, `erroneous`, `reprocess` and `payment`. `src/engine/scenarios.js` describes each one in one sentence. `GET /mock/config` lists them too.

## Faults

A fault makes the exchange fail in a way that NHA's sandbox failed. Set faults with `POST /mock/fault`, for example `{"http503":true}`. Send `{"reset":true}` to clear them. The faults are `http503`, `http500`, `noHealthyUpstream`, `upstreamConnectError`, `slow` (milliseconds), `noCallback`, `duplicateCallback`, `truncatedJwe`, `jwePayloadWrapper`, `chunkedCallback` and `sessionRefuse`. Each fault body is a copy of a real NHA answer, except `chunkedCallback` and the `sessionRefuse` body, which are predicted.

## Timing

The answer to the HTTP request is immediate. Each callback waits a delay. Set the delay with `POST /mock/timing`. The modes are fixed (`{"mode":"fixed","ms":300}`), random (`{"mode":"random","min":3000,"max":10000}`) and sequence. The presets in `src/server/timing.js` (`preauth-partial`, `claim-partial`, `coverage` and others) are gaps that were measured on real sandbox traffic. The header `X-Mock-Delay` sets the delay for one request.

## The desk

1518 had a person who decided pre-auths and claims. The simulator has a desk for the same job. Use scenario `pending` or `manual`, then decide each case:

- On the page at `/`, or
- With `GET /mock/pending` and `POST /mock/desk/<id> {"decision":"approve|partial|query|reject","amount":0,"note":""}`.

`POST /mock/cases/reset` clears the open cases.

## The playground

The playground lets you learn the payer rules without a HIMS. You pick a scenario and a member. The simulator takes a real request from `fixtures/`, runs it through the same rules, and shows the answer. Use `GET /playground/catalogue`, `POST /playground/preview`, `POST /playground/run` and `POST /playground/reset`. The playground has its own case store, so it does not change the cases of a connected HIMS.

## How to add a rule or a scenario

`docs/ADDING-A-SCENARIO.md` gives a full example. In short:

1. Add the rule to `src/engine/rules.js`, or the scenario to `src/engine/scenarios.js`.
2. Add a test to `test/engine.rules.test.js` or `test/engine.scenarios.test.js`. The test sends a bundle that breaks the rule and gets the code, then sends the same bundle fixed and gets no code.
3. If 1518 sent a real answer, add it as a fixture in `fixtures/<name>/`, with all personal data and hospital ids replaced by fakes.

Every rule must cite real evidence in its `source` field: a message id, a date, or an NHA document. A test (`every rule names its source`) fails when a rule has no source. If the rule is a guess, write "predicted" in the source.

## What is real and what is predicted

Real means that the simulator copies what NHA or 1518 sent in sandbox traffic. The fixtures are derived from that traffic, with identifiers and times changed. These parts are real: the error codes and their text, the shape of each answer bundle (the tests compare each builder with a fixture), the registry answers, the fault bodies, and the timing presets.

Predicted means that no real answer exists to compare with. The code marks each predicted part. Examples are the order in which 1518 checks its rules, the amount on a partial approval, and some refusal bodies of the exchange. `fixtures/INDEX.md` lists the scenarios that have no real data.

## Limits

- The simulator cannot prove that the real 1518 accepts a new payload. It shows only that the payload passes the rules that 1518 was seen to apply. Run the final test against NHA's sandbox.
- The simulator cannot do a real face or fingerprint check. The presence and face authentication calls always succeed.
- The rules come from what 1518 did in the sandbox. Production behavior can be different.

## More documents

- `docs/ARCHITECTURE.md`: the modules and how a request moves through them.
- `docs/ADDING-A-SCENARIO.md`: a worked example of a new rule and scenario.
- `fixtures/INDEX.md`: where each fixture came from and how it was scrubbed.
- `examples/`: optional scripts and files, for example several simulator instances side by side.

## License

No license has been chosen yet.
