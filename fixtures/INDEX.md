# Fixture index

Every fixture below is derived from a real message pair in sandbox traffic between a HIMS and 1518@hcx.
Identifiers and times were changed, so a fixture cannot be matched to a real log row. Where a scenario
has no real data it is listed under "No real data" and has no folder.

Each folder holds request.json (what the HIMS sent), response.json (the final 1518 answer),
response-ack.json when 1518 first sent a queued response.partial, and meta.json (date, endpoint,
outcome, source, what was scrubbed).

Scrubbing: patient and practitioner names, phones, addresses, birth dates, ABHA, JHN and HPR numbers
are replaced with fixed fakes (TEST PATIENT, DR TEST DOCTOR, 9000000000, 91-0000-0000-0000,
1990-01-01). Every attachment body is replaced with one tiny valid PDF, and meta.json counts them.
Member id SBXSTG269 (NHA's sandbox test member) is kept. The hospital's ids, case numbers, bill
numbers, preAuthRef values and payer officer ids were replaced with fakes in the same format
(provider 1000000001@hcx, registry id IN0000000000, hospital id 10001, case numbers from A/9001/26).
All clock times in the bundles were moved by one fixed offset, so the order and gaps between
messages stay true. The leak check in _tools/extract.py is a string search for the real values it
replaced. It cannot find personal data that the scrubber never collected, so free text in
dispositions was also read by eye (no names found).

To rebuild from a new capture, see the usage text at the top of `fixtures/_tools/extract.py`. The
scenario list and the private map of fixtures to real message ids stay outside the repository.

## Real data

| Scenario | Data | Ack | Case | Date |
|---|---|---|---|---|
| happy-coverage | real | - | A/9022/26 | 2026-11-20 |
| happy-preauth | real | yes | A/9022/26 | 2026-11-20 |
| happy-claim | real | yes | A/9022/26 | 2026-11-20 |
| payment-notice | real | - | A/9022/26 | 2026-11-20 |
| preauth-rejected | real | yes | A/9012/26 | 2026-11-16 |
| preauth-queried | real | yes | A/9012/26 | 2026-11-16 |
| preauth-resend-approved | real | yes | A/9012/26 | 2026-11-16 |
| claim-queried | real | yes | A/9016/26 | 2026-11-19 |
| claim-rejected | real | yes | A/9016/26 | 2026-11-19 |
| claim-reprocess | real | - | A/9016/26 | 2026-11-19 |
| preauth-cancel | real | - | A/9011/26 | 2026-11-16 |
| implant-preauth | real | - | A/9013/26 | 2026-11-17 |
| implant-claim | real | yes | A/9013/26 | 2026-11-17 |
| enhancement-approved | real | yes | A/9017/26 | 2026-11-19 |
| room-level-sn063d | real | yes | A/9010/26 | 2026-11-16 |
| newborn-preauth | real | yes | A/9020/26 | 2026-11-20 |
| newborn-claim | real | yes | A/9020/26 | 2026-11-20 |
| lama-claim | real | yes | A/9015/26 | 2026-11-18 |
| dama-claim | real | yes | A/9019/26 | 2026-11-20 |
| death-after-surgery-claim | real | yes | A/9014/26 | 2026-11-17 |
| death-after-surgery-preauth | real | yes | A/9014/26 | 2026-11-17 |
| death-before-surgery-claim | real | yes | A/9018/26 | 2026-11-19 |
| two-packages-preauth | real | - | A/9024/26 | 2026-11-23 |
| error-err-pyr-sr-002-no-claim-history-with-requested-details | real | - | A/9007/26 | 2026-11-12 |
| error-hbp0006-no-data-configured-for-the-given-payer | real | - | NULL | 2026-11-16 |
| error-hbp016-no-policies-available-for-the-selected-p | real | - | A/9004/26 | 2026-11-13 |
| error-hbp039-selected-policy-code-is-invalid | real | - | A/9009/26 | 2026-11-13 |
| error-payr-1008-invalid-base64-value-received-in-attachm | real | - | A/9007/26 | 2026-11-10 |
| error-payr-1045-invalid-quantity-received-for-item-henc | real (no request) | - | NULL | 2026-11-09 |
| error-payr-1111-implant-is-applicable-for-procedure-code | real | - | NULL | 2026-11-16 |
| error-payr-1111-stratification-is-allowed-for-procedure | real | - | NULL | 2026-11-16 |
| error-payr-1114-invalid-speciality-code-received-as-null | real | - | NULL | 2026-11-09 |
| error-payr-1123-beneficiary-is-not-a-covered-member-for | real | - | A/9021/26 | 2026-11-20 |
| error-payr-1238-beneficiary-is-having-an-active-preautho | real | - | A/9017/26 | 2026-11-18 |
| error-payr-1245-enhancement-is-not-applicable-on-the-pre | real | - | A/9007/26 | 2026-11-10 |
| error-payr-1245-only-one-conservative-procedure-can-be-b | real | - | A/9010/26 | 2026-11-16 |
| error-payr-1250-requested-policy-100217-is-not-listed-p | real | - | A/9008/26 | 2026-11-13 |
| error-payr-1263-documents-are-mandatory-for-the-new-born | real | - | A/9020/26 | 2026-11-20 |
| error-payr-1323-insufficient-wallet-balance-hence-the-r | real | - | A/9015/26 | 2026-11-18 |
| error-payr-1357-admission-date-cannot-be-after-the-disch | real | - | A/9010/26 | 2026-11-16 |
| error-payr-1372-active-event-found-with-correlation-id-c | real | - | A/9008/26 | 2026-11-16 |
| error-payr-1402-requested-policy-100217-found-not-be-ass | real | - | A/9007/26 | 2026-11-12 |

The PAYR-1045 error (9 Nov) has no HIMS request with the same correlation
id, so that folder has no request.json.

Only one fixture is kept per distinct error code and message start; PAYR-1008 was seen for three
items (DCR, FB, MAND0584) and only the latest is kept. PAYR-1263 appears 13 times; the latest
(A/9020/26) is kept.

## No real data

| Scenario | Why there is none |
|---|---|
| Communication request from 1518 | 1518 never sent /v1/communication/request to the HIMS. All such rows come from other payers (1000003315@hcx, 1000003538@hcx). |
| Partial approval (approved amount below the claimed amount) | No 1518 ClaimResponse has benefit below submitted with an approval. The only non-equal totals are queries and rejections (benefit 0). |
| Cancel reply carrying a PC02 code | The one real cancel (A/9011/26, fixture preauth-cancel) has Task status completed, ClaimResponse adjudication status cancelled, and no PC02 anywhere. No 1518 payload contains PC02. |
| Two packages: final decision | A/9024/26 has only the queued ack fixture two-packages-preauth; no response.complete row exists as of 2026-11-24. Folder two-packages-preauth holds the ack as response.json. |
| Two packages: claim | No claim was sent for A/9024/26. |
| Reprocess: final decision after the Task | fixture claim-reprocess accepted the reprocess Task; no later ClaimResponse for A/9016/26 is in the traffic. |
