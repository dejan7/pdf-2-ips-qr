/*
 * NBS IPS QR logic for Serbian payment orders ("НАЛОГ ЗА ПРЕНОС", образац бр.3).
 * A port of ../uplatnica_qr.py with the same rules. It has no DOM access, so
 * the browser (window.IPS) and Node tests (require) share it.
 */
(function (root) {
  "use strict";

  const NBS_VALIDATE_URL = "https://nbs.rs/QRcode/api/qr/v1/validate";

  const MAX_NAME = 70; // N (recipient) and P (payer)
  const MAX_PURPOSE = 35; // S
  const TEXT_LIMITS = { platilac: MAX_NAME, primalac: MAX_NAME, svrha: MAX_PURPOSE };
  const MAX_REFERENCE = 25; // RO (model + reference)

  const ROW_TOLERANCE = 8; // points; right-column boxes within this y-distance share a row

  const SLIP_FIELDS = [
    "platilac", "svrha", "primalac", "sifra", "valuta", "iznos",
    "racunPlatioca", "racunPrimaoca", "modelOdobrenja", "pozivOdobrenja",
  ];

  class SlipError extends Error {
    constructor(message, field) {
      super(message);
      this.name = "SlipError";
      this.field = field;
    }
  }

  function emptySlip() {
    return Object.fromEntries(SLIP_FIELDS.map((k) => [k, ""]));
  }

  function isEmptySlip(slip) {
    return !slip.racunPrimaoca && !slip.iznos;
  }

  // ------------------------------------------------------------------------
  // PDF extraction
  // ------------------------------------------------------------------------

  /** Trim, collapse repeated whitespace, and drop the '|' payload separator. */
  function clean(value) {
    return String(value ?? "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  }

  function widgetPageIndex(doc, pages, widget) {
    const p = widget.P();
    const byP = p ? pages.findIndex((pg) => pg.ref === p) : -1;
    if (byP !== -1) return byP;
    const ref = doc.context.getObjectRef(widget.dict);
    return pages.findIndex((pg) => {
      const annots = pg.node.Annots();
      return !!ref && !!annots && annots.asArray().includes(ref);
    });
  }

  /** Return [{pageWidth, fields: [{value, x0, y0, x1, y1}]}] for each page. */
  async function extractFields(PDFLib, bytes) {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    const out = pages.map((pg) => ({ pageWidth: pg.getMediaBox().width, fields: [] }));
    for (const field of doc.getForm().getFields()) {
      if (!(field instanceof PDFLib.PDFTextField)) continue;
      const value = clean(field.getText());
      for (const widget of field.acroField.getWidgets()) {
        const i = widgetPageIndex(doc, pages, widget);
        if (i === -1) continue;
        const r = widget.getRectangle();
        out[i].fields.push({
          value,
          x0: Math.min(r.x, r.x + r.width), x1: Math.max(r.x, r.x + r.width),
          y0: Math.min(r.y, r.y + r.height), y1: Math.max(r.y, r.y + r.height),
        });
      }
    }
    return out;
  }

  const xc = (f) => (f.x0 + f.x1) / 2;
  const yc = (f) => (f.y0 + f.y1) / 2;

  /** Group fields into rows by y-center, top to bottom, each row left to right. */
  function rows(fields) {
    const out = [];
    for (const f of [...fields].sort((a, b) => yc(b) - yc(a))) {
      const last = out[out.length - 1];
      if (last && Math.abs(yc(last[0]) - yc(f)) <= ROW_TOLERANCE) last.push(f);
      else out.push([f]);
    }
    return out.map((r) => r.sort((a, b) => a.x0 - b.x0));
  }

  /** Split one page's fields into slips and assign each field its role. */
  function parsePage({ pageWidth, fields }) {
    if (!fields.length) return [];
    const midX = pageWidth / 2;
    const left = fields.filter((f) => xc(f) < midX).sort((a, b) => yc(b) - yc(a));
    const right = fields.filter((f) => xc(f) >= midX);

    if (left.length % 3) throw new SlipError(`expected 3 left-column boxes per slip, found ${left.length}`);
    const groups = [];
    for (let i = 0; i < left.length; i += 3) groups.push(left.slice(i, i + 3));

    // Slip boundaries sit halfway between one slip's last left box and the next slip's first.
    const bounds = [Infinity];
    for (let i = 0; i + 1 < groups.length; i++) bounds.push((groups[i][2].y0 + groups[i + 1][0].y1) / 2);
    bounds.push(-Infinity);

    return groups.map(([payer, purpose, recipient], i) => {
      const top = bounds[i], bottom = bounds[i + 1];
      const r = rows(right.filter((f) => bottom < yc(f) && yc(f) <= top));
      const shape = r.map((row) => row.length);
      if (shape.join() !== "3,1,2,1,2") {
        throw new SlipError(`slip ${i + 1}: unexpected right-column layout [${shape}], expected [3,1,2,1,2]`);
      }
      const [[sifra, valuta, iznos], [racunPl], , [racunPr], [model, poziv]] = r;
      return {
        platilac: payer.value,
        svrha: purpose.value,
        primalac: recipient.value,
        sifra: sifra.value,
        valuta: valuta.value,
        iznos: iznos.value,
        racunPlatioca: racunPl.value,
        racunPrimaoca: racunPr.value,
        modelOdobrenja: model.value,
        pozivOdobrenja: poziv.value,
      };
    });
  }

  /** Return all slips in the PDF in reading order, including empty ones. */
  async function parsePdf(PDFLib, bytes) {
    const pages = await extractFields(PDFLib, bytes);
    return pages.flatMap(parsePage);
  }

  // ------------------------------------------------------------------------
  // Normalization / validation
  // ------------------------------------------------------------------------

  const isDigits = (s) => /^\d+$/.test(s);

  function mod97Control(digits) {
    return Number(98n - ((BigInt(digits) * 100n) % 97n));
  }

  /** Return the 18-digit form of a Serbian account number, checking its control digits. */
  function normalizeAccount(account) {
    let s = account.replace(/\s/g, "");
    if (!s) throw new SlipError("račun primaoca nije popunjen", "racunPrimaoca");
    const bad = () => new SlipError(`neispravan format računa: ${account}`, "racunPrimaoca");
    if (s.includes("-")) {
      const parts = s.split("-");
      if (parts.length !== 3 || !parts.every(isDigits)) throw bad();
      const [bank, number, control] = parts;
      if (bank.length !== 3 || control.length !== 2 || number.length > 13) throw bad();
      s = bank + number.padStart(13, "0") + control;
    }
    if (!(isDigits(s) && s.length === 18)) throw new SlipError(`račun mora imati 18 cifara: ${account}`, "racunPrimaoca");
    if (mod97Control(s.slice(0, 16)) !== Number(s.slice(16))) {
      throw new SlipError(`kontrolni broj računa nije ispravan: ${account}`, "racunPrimaoca");
    }
    return s;
  }

  /** Turn '=17.074,03', '17074.03', etc. into the IPS form 'RSD17074,03'. */
  function normalizeAmount(amount) {
    const s = amount.replace(/rsd|din\.?|[=\s]/gi, "");
    if (!s) throw new SlipError("iznos nije popunjen", "iznos");
    // The last separator is the decimal one, unless it is followed by exactly
    // 3 digits (then it groups thousands, e.g. '17.074').
    const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    let integer = s, decimals = "0";
    if (last !== -1 && [1, 2].includes(s.length - last - 1)) {
      integer = s.slice(0, last);
      decimals = s.slice(last + 1);
    }
    integer = integer.replace(/[.,]/g, "");
    if (!(isDigits(integer) && isDigits(decimals))) throw new SlipError(`neispravan iznos: ${amount}`, "iznos");
    const whole = BigInt(integer).toString();
    const cents = decimals.padEnd(2, "0");
    if (whole === "0" && /^0+$/.test(cents)) throw new SlipError(`iznos mora biti veći od nule: ${amount}`, "iznos");
    return `RSD${whole},${cents}`;
  }

  function checkCurrency(currency) {
    if (currency && !["RSD", "DIN", "DIN."].includes(currency.trim().toUpperCase())) {
      throw new SlipError(`IPS podržava samo dinare (RSD), a valuta je „${currency}”`, "valuta");
    }
  }

  function checkPaymentCode(code) {
    if (!/^[12]\d\d$/.test(code)) {
      throw new SlipError(`šifra plaćanja mora imati 3 cifre i počinjati sa 1 ili 2: ${code || "(prazno)"}`, "sifra");
    }
    return code;
  }

  /** Return the RO value (model + reference), or '' when there is no reference. */
  function normalizeReference(model, reference) {
    const ref = reference.replace(/[\s-]/g, "");
    if (!ref) return "";
    model = model.replace(/\s/g, "") || "00";
    if (!/^\d\d$/.test(model)) throw new SlipError(`model mora imati 2 cifre: ${model}`, "modelOdobrenja");
    if (model === "97") {
      if (!(isDigits(ref) && ref.length >= 3)) {
        throw new SlipError(`poziv na broj za model 97 sme da sadrži samo cifre: ${reference}`, "pozivOdobrenja");
      }
      if (mod97Control(ref.slice(2)) !== Number(ref.slice(0, 2))) {
        throw new SlipError(`kontrolni broj poziva na broj (model 97) nije ispravan: ${reference}`, "pozivOdobrenja");
      }
    }
    const ro = model + ref;
    if (ro.length > MAX_REFERENCE) {
      throw new SlipError(`model i poziv na broj su duži od ${MAX_REFERENCE} znakova`, "pozivOdobrenja");
    }
    return ro;
  }

  function limit(value, maxLen, field, truncate) {
    const chars = [...value];
    if (chars.length <= maxLen) return value;
    if (truncate) return chars.slice(0, maxLen).join("").trimEnd();
    throw new SlipError(`najviše ${maxLen} znakova (sada ${chars.length})`, field);
  }

  /**
   * Check every field of a slip. Returns {payload, errors}: payload is the
   * NBS IPS 'PR' string, or null when errors (a list of SlipError) is non-empty.
   */
  function validateSlip(slip, { truncate = false } = {}) {
    const s = Object.fromEntries(SLIP_FIELDS.map((k) => [k, clean(slip[k])]));
    const errors = [];
    const attempt = (fn) => {
      try {
        return fn();
      } catch (e) {
        if (!(e instanceof SlipError)) throw e;
        errors.push(e);
        return "";
      }
    };
    attempt(() => checkCurrency(s.valuta));
    const tags = [
      ["K", "PR"],
      ["V", "01"],
      ["C", "1"],
      ["R", attempt(() => normalizeAccount(s.racunPrimaoca))],
      ["N", attempt(() => {
        if (!s.primalac) throw new SlipError("primalac nije popunjen", "primalac");
        return limit(s.primalac, MAX_NAME, "primalac", truncate);
      })],
      ["I", attempt(() => normalizeAmount(s.iznos))],
      ["P", attempt(() => limit(s.platilac, MAX_NAME, "platilac", truncate))],
      ["SF", attempt(() => checkPaymentCode(s.sifra))],
      ["S", attempt(() => limit(s.svrha, MAX_PURPOSE, "svrha", truncate))],
      ["RO", attempt(() => normalizeReference(s.modelOdobrenja, s.pozivOdobrenja))],
    ];
    const payload = errors.length ? null : tags.filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join("|");
    return { payload, errors };
  }

  /** Build the NBS IPS 'PR' payload string for one slip; throws the first SlipError. */
  function buildPayload(slip, opts) {
    const { payload, errors } = validateSlip(slip, opts);
    if (errors.length) throw errors[0];
    return payload;
  }

  /**
   * Send the payload to NBS's validator. Returns {ok, message}; ok is null
   * when the check could not run.
   */
  async function validateOnline(payload, fetchImpl = root.fetch) {
    let body;
    try {
      const resp = await fetchImpl(NBS_VALIDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: payload,
      });
      body = await resp.text();
    } catch (e) {
      return { ok: null, message: `zahtev nije uspeo: ${e.message}` };
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { ok: null, message: `neočekivan odgovor: ${body.slice(0, 200)}` };
    }
    const status = data.s || {};
    return { ok: status.code === 0, message: status.desc || body };
  }

  const api = {
    NBS_VALIDATE_URL, SLIP_FIELDS, TEXT_LIMITS, SlipError,
    emptySlip, isEmptySlip, clean,
    extractFields, parsePage, parsePdf,
    mod97Control, normalizeAccount, normalizeAmount, checkCurrency, checkPaymentCode,
    normalizeReference, limit, validateSlip, buildPayload, validateOnline,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IPS = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
