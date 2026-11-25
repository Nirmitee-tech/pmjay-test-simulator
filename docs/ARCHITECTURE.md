# Architecture

The simulator is one Node.js 20 process in CommonJS. It uses only the Node.js standard library. The default port is 9300.

## Modules

- `src/server/`: HTTP, sessions, the participant registry, the `/v1/*` use-case endpoints, JWE decryption and encryption, callbacks to the HIMS, faults, timing, the message log, the desk, the playground, and the page in `ui/`.
- `src/engine/`: the scenario list, the bundle reader, the payer rules, and the case state (open pre-auths per member, pending events, wallet). It decides each answer.
- `src/responses/`: the builders for the answer bundles. Each builder copies the shape of a real 1518 answer.
- `fixtures/`: real request and answer pairs from sandbox traffic, scrubbed. The tests compare the builders and the rules with them.

## How a request moves

1. The HIMS sends a JWE to `<sim>/hcx/v1/<entity>/<action>`.
2. `src/server/protocol.js` applies the checks that the NHCX exchange makes on the headers. If a check fails, the HIMS gets the NHCX error at once.
3. `src/server/app.js` decrypts the payload with the key of `1518@hcx` and returns HTTP 202.
4. The server calls the engine:

       const r = require('../engine').handle({ action, apiCallId, correlationId, sender, recipient, headers, bundle })

   The result is `{ sync: {status, body} | null, callbacks: [{ action, delayMs, bundle, hcxStatus, error? }] }`. The value of `hcxStatus` is `response.complete`, `response.partial` or `response.error`.
5. The engine calls `require('../responses').build(kind, ctx)` for each answer bundle.
6. `src/server/callbacks.js` encrypts each answer with the certificate of the HIMS and posts it to `<callbackBase>/v1/<entity>/on_<action>` after the delay.

## Scenario selection

The simulator uses the first of these that is set:

1. The header `X-Mock-Scenario` on the request.
2. The scenario set with `POST /mock/scenario {"scenario":"<id>"}`.
3. The default, `auto`, where the rules decide.

## The dummy payer

Requests to `1000003538@hcx` go to `<sim>/dummyhcxpayer`. The simulator holds those pre-auths and claims until a `/process/request` call names a decision. It sends a payment notice on `/paymentNotice/init`.

## Data

`data/` holds the payer key pair and `log.jsonl`. It is not in git. Delete it to start clean. A new key pair is then made at the next start, and the HIMS must fetch the new certificate.
