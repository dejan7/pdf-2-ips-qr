const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const IPS = require("./ips.js");
const PDFLib = require("./vendor/pdf-lib.min.js");

const SAMPLE = path.join(__dirname, "..", "НАЛОГ - plata - Suzana (1).pdf");

const slip = (fields) => ({ ...IPS.emptySlip(), ...fields });

test("normalizeAmount", () => {
  const cases = {
    "=17074.03": "RSD17074,03",
    "17074,03": "RSD17074,03",
    "17.074,03": "RSD17074,03",
    "17,074.03": "RSD17074,03",
    "1.234.567,8": "RSD1234567,80",
    "17.074": "RSD17074,00",
    "500": "RSD500,00",
    "RSD 27760.80": "RSD27760,80",
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(IPS.normalizeAmount(raw), expected, raw);
  for (const bad of ["", "=0", "abc", "12a.00"]) assert.throws(() => IPS.normalizeAmount(bad), IPS.SlipError, bad);
});

test("normalizeAccount", () => {
  assert.equal(IPS.normalizeAccount("840-4848-37"), "840000000000484837");
  assert.equal(IPS.normalizeAccount("265-4010310004852-43"), "265401031000485243");
  assert.equal(IPS.normalizeAccount("325 930070587872993"), "325930070587872993");
  for (const bad of ["840-4848-38", "840-4848", "12345", ""]) {
    assert.throws(() => IPS.normalizeAccount(bad), IPS.SlipError, bad);
  }
});

test("normalizeReference", () => {
  assert.equal(IPS.normalizeReference("97", "3191000000065383498"), "973191000000065383498");
  assert.throws(() => IPS.normalizeReference("97", "3291000000065383498"), IPS.SlipError);
  assert.equal(IPS.normalizeReference("", "12-345"), "0012345");
  assert.equal(IPS.normalizeReference("97", ""), "");
});

test("payment code and currency", () => {
  assert.equal(IPS.checkPaymentCode("289"), "289");
  for (const bad of ["389", "28", ""]) assert.throws(() => IPS.checkPaymentCode(bad), IPS.SlipError, bad);
  IPS.checkCurrency("rsd");
  assert.throws(() => IPS.checkCurrency("EUR"), IPS.SlipError);
});

test("payload tag order and optional tags", () => {
  const s = slip({ primalac: "Pera", sifra: "289", iznos: "100", racunPrimaoca: "840-4848-37" });
  assert.equal(IPS.buildPayload(s), "K:PR|V:01|C:1|R:840000000000484837|N:Pera|I:RSD100,00|SF:289");
});

test("long purpose needs truncate", () => {
  const s = slip({ primalac: "Pera", sifra: "289", iznos: "100", racunPrimaoca: "840-4848-37", svrha: "x".repeat(40) });
  assert.throws(() => IPS.buildPayload(s), IPS.SlipError);
  assert.ok(IPS.buildPayload(s, { truncate: true }).includes("|S:" + "x".repeat(35)));
});

test("validateSlip reports every bad field at once", () => {
  const { payload, errors } = IPS.validateSlip(slip({ sifra: "9", valuta: "EUR", racunPrimaoca: "1-2-3" }));
  assert.equal(payload, null);
  assert.deepEqual(errors.map((e) => e.field).sort(), ["iznos", "primalac", "racunPrimaoca", "sifra", "valuta"]);
});

test("sample PDF end to end", async () => {
  const slips = await IPS.parsePdf(PDFLib, fs.readFileSync(SAMPLE));
  assert.equal(slips.length, 3);
  assert.ok(IPS.isEmptySlip(slips[2]));
  assert.deepEqual(slips.slice(0, 2).map((s) => IPS.buildPayload(s)), [
    "K:PR|V:01|C:1|R:840000000000484837|N:Ministarstvo finansija RS, P.uprava-Beogad,Save Maškovića 3-5" +
      "|I:RSD17074,03|P:GAMAJUN DOO|SF:254|S:PID- 9-2026|RO:973191000000065383498",
    "K:PR|V:01|C:1|R:325930070587872993|N:Suzana Stosic|I:RSD27760,80|P:GAMAJUN DOO|SF:240|S:plata" +
      "|RO:973191000000065383498",
  ]);
});
