"""Builds fixtures/<scenario>/ from real sandbox message payloads.

Usage: python3 -I extract.py <rows.txt> <rawdir> <fixturesdir> <scenarios.json> <private-map.json>
The private map (fixture -> real message ids and times) must be written outside the repo, for example to data/.
rows.txt is the pipe export of message-log rows for 1518 (Id|Direction|Endpoint|HcxStatus|
CorrelationId|ErrorCode|ErrorMessage|PayloadRef|IpdNo|ReceivedAt), rawdir holds <Id>.json copied
read-only from the HIMS's inbox folder (the file named in PayloadRef).
Scrubbing replaces patient and practitioner names, phones, addresses, ABHA and other beneficiary
numbers with fixed fakes, and every attachment body with one small PDF. It keeps SBXSTG269. A second
pass, not in this script, then replaced the hospital's ids, case numbers, bill numbers and preAuthRef
with fakes in the same format; run the same kind of pass on any new capture before committing it. The final grep in check_clean() is a string search for the
real values that were replaced; it does not catch PHI the scrubber never collected.
"""
import json, os, re, sys, base64

ROWS, RAW, OUT, _SCEN, PRIVATE_MAP = sys.argv[1:6]
TINY_PDF = base64.b64encode(b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").decode()

rows = {}
for l in open(ROWS, encoding='utf-8'):
    f = l.rstrip('\n').split('|')
    if len(f) >= 10:
        rows[f[0]] = dict(id=f[0], dir=f[1].strip(), ep=f[2], st=f[3], cid=f[4], err=f[5], msg=f[6], ref=f[7], ipd=f[8], at=f[9])

FAKE_PATIENT = 'TEST PATIENT'
FAKE_DOCTOR = 'DR TEST DOCTOR'
FAKE_BIRTH = '1990-01-01'
FAKE_NEWBORN_BIRTH = '2026-01-01'
KEEP_IDS = {'SBXSTG269'}

class Scrub:
    def __init__(self):
        self.names, self.numbers, self.pdfs = set(), set(), 0
    def name(self, n, fake):
        if isinstance(n, dict):
            for k in ('text', 'family'):
                if n.get(k): self.names.add(n[k]); n[k] = fake
            if n.get('given'):
                for g in n['given']: self.names.add(g)
                n['given'] = [fake]
            if 'prefix' in n: n['prefix'] = []
    def ident(self, idl):
        for i in idl or []:
            code = ((i.get('type') or {}).get('coding') or [{}])[0].get('code', '')
            sysu = i.get('system', '') or ''
            v = i.get('value')
            if not v or v in KEEP_IDS: continue
            if code in ('ABHA', 'JHN', 'PI', 'ADN', 'PPN', 'AADHAAR') or re.search('abha|healthid|aadhaar', sysu, re.I) or re.search(r'@(sbx|abdm)$', str(v)):
                self.numbers.add(v); i['value'] = '91-0000-0000-0000' if re.search('abha|healthid', sysu + code, re.I) else 'FAKE' + str(abs(hash(v)) % 10**8).zfill(8)
            elif code in ('HPIN', 'MD'):
                self.numbers.add(v); i['value'] = '00-0000-0000-0000'
    def person(self, r, fake):
        for n in r.get('name') or []: self.name(n, fake)
        for t in r.get('telecom') or []:
            if t.get('value'): self.numbers.add(t['value']); t['value'] = '9000000000'
        if r.get('address'):
            for a in r['address']:
                for k in list(a.keys()):
                    if k == 'line': self.names.update(x for x in a[k] if len(x) > 3); a[k] = ['1 Test Street']
                    elif k in ('text',): self.names.add(a[k]); a[k] = '1 Test Street, Testpur'
                    elif k == 'postalCode': a[k] = '000000'
        for c in r.get('contact') or []:
            self.name(c.get('name'), fake)
            for t in c.get('telecom') or []:
                if t.get('value'): t['value'] = '9000000000'
        self.ident(r.get('identifier'))
    def walk(self, o):
        if isinstance(o, dict):
            rt = o.get('resourceType')
            if rt in ('Patient', 'RelatedPerson'):
                self.person(o, FAKE_PATIENT)
                # birth dates: one fixed fake; a newborn (linked as "refer" or born after 2020) gets a fixed fake too
                if o.get('birthDate'):
                    o['birthDate'] = FAKE_NEWBORN_BIRTH if o['birthDate'] >= '2020' else FAKE_BIRTH
            elif rt == 'Practitioner': self.person(o, FAKE_DOCTOR)
            if isinstance(o.get('data'), str) and len(o['data']) > 40:
                o['data'] = TINY_PDF; o['contentType'] = 'application/pdf'; self.pdfs += 1
                for k in ('size', 'hash'): o.pop(k, None)
            for k in ('x-hcx-ben-abha-id',):
                if o.get(k): self.numbers.add(o[k]); o[k] = '91-0000-0000-0000'
            for v in o.values(): self.walk(v)
        elif isinstance(o, list):
            for v in o: self.walk(v)
    def finish(self, text):
        for n in sorted((x for x in self.names if x and len(x) > 2 and x not in (FAKE_PATIENT, FAKE_DOCTOR)), key=len, reverse=True):
            text = re.sub(re.escape(n), FAKE_PATIENT, text, flags=re.I)
        for n in sorted((x for x in self.numbers if x and len(x) > 4), key=len, reverse=True):
            text = text.replace(n, 'FAKE-ID')
        return text

def load(i):
    p = os.path.join(RAW, i + '.json')
    if not i or not os.path.exists(p) or os.path.getsize(p) == 0: return None
    return json.loads(open(p, encoding='utf-8-sig').read())

ALL_REAL = set()
PRIVATE = []
def write(name, outcome, req_id, resp_id, ack_id=None, note='', direction='HIMS to 1518'):
    d = os.path.join(OUT, name); os.makedirs(d, exist_ok=True)
    sc = Scrub()
    files = {}
    for fn, i in (('request.json', req_id), ('response.json', resp_id), ('response-ack.json', ack_id)):
        o = load(i) if i else None
        if o is None: continue
        sc.walk(o); files[fn] = o
    # second pass on text so names inside free text (Baby of X, dispositions) are caught
    for fn, o in files.items():
        t = sc.finish(json.dumps(o, indent=1, ensure_ascii=False))
        open(os.path.join(d, fn), 'w', encoding='utf-8').write(t + '\n')
    ALL_REAL.update(x for x in sc.names | sc.numbers if x and len(x) > 4 and x not in (FAKE_PATIENT, FAKE_DOCTOR))
    r = rows.get(resp_id, {}); q = rows.get(req_id, {})
    meta = dict(scenario=name, outcome=outcome, direction=direction,
                request=dict(endpoint=q.get('ep'), status=q.get('st')) if req_id else None,
                response=dict(endpoint=r.get('ep'), hcxStatus=r.get('st'), errorCode=r.get('err'), errorMessage=r.get('msg')),
                ack=dict(endpoint=rows.get(ack_id, {}).get('ep'), hcxStatus=rows.get(ack_id, {}).get('st')) if ack_id else None,
                caseNumber=r.get('ipd') or q.get('ipd'), correlationId=r.get('cid'), date=(r.get('at') or '')[:10],
                files=sorted(files), missing=[fn for fn, i in (('request.json', req_id),) if not i or fn not in files],
                source='derived from sandbox traffic between a HIMS and 1518@hcx; identifiers and times changed',
                scrubbed=dict(attachmentsReplacedWithTinyPdf=sc.pdfs, namesReplaced=len(sc.names), numbersReplaced=len(sc.numbers),
                              rule='patient/practitioner names, phones, addresses, ABHA/JHN/PI/HPR ids replaced with fixed fakes; SBXSTG269 kept; hospital ids, case numbers, bill numbers and preAuthRef replaced with fakes in the same format'),
                note=note)
    open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8').write(json.dumps(meta, indent=1, ensure_ascii=False) + '\n')
    PRIVATE.append(dict(scenario=name, request=req_id, response=resp_id, ack=ack_id, requestAt=q.get('at'), responseAt=r.get('at')))
    return meta

# The scenario list names real message ids, so it lives outside the repo (argv[4], a JSON list of
# [name, outcome, request id, final response id, ack id, note]).
SCEN = json.load(open(sys.argv[4], encoding='utf-8'))

def main():
    index = []
    for s in SCEN:
        m = write(*s); index.append(m)
    # errors: one per distinct (code, message start), latest response
    seen = {}
    for r in sorted(rows.values(), key=lambda r: int(r['id'])):
        if r['st'] != 'response.error': continue
        seen[(r['err'], r['msg'][:45])] = r
    for (code, _), r in sorted(seen.items()):
        req = next((q['id'] for q in rows.values() if q['cid'] == r['cid'] and q['dir'] == 'OUT' and r['cid'] not in ('', 'NULL')), None)
        tail = re.sub(r'[^a-z0-9]+', '-', r['msg'][:40].lower()).strip('-')
        name = 'error-%s-%s' % (code.lower(), tail)
        m = write(name, 'error %s' % code, req, r['id'], None, 'ProtocolResponse error on %s, case %s.' % (r['ep'], r['ipd']) + ('' if req else ' No HIMS request row shares this correlation id, so request.json is missing.'))
        index.append(m)
    json.dump(PRIVATE, open(PRIVATE_MAP, 'w'), indent=1)
    # leak check
    leaks = []
    for root, _, fs in os.walk(OUT):
        for f in fs:
            if not f.endswith('.json') or '_tools' in root: continue
            t = open(os.path.join(root, f), encoding='utf-8').read()
            for v in ALL_REAL:
                if v.lower() in t.lower(): leaks.append((root, f, v[:3] + '...'))
    print('scenarios', len(index), 'leaks', len(leaks))
    for l in leaks[:20]: print('LEAK', l)
    sys.exit(1 if leaks else 0)

main()
