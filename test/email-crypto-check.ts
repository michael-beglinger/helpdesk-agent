/**
 * Manueller Crypto-Check für src/email.ts — nicht Teil von `npm test`
 * (braucht einen lokal generierten Test-RSA-Key, siehe README-Hinweis unten).
 * Prüft mit einem echten Schlüsselpaar, dass:
 *  - pemToArrayBuffer sowohl echte Newlines als auch literale "\n" verarbeitet
 *  - importPrivateKey + crypto.subtle.sign eine gültige RS256-Signatur erzeugt
 *    (unabhängig mit Node's crypto.verify geprüft)
 *  - buildRawMessage/encodeHeaderValue eine korrekte RFC2047-Kodierung liefert
 */
import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildRawMessage,
  encodeHeaderValue,
  importPrivateKey,
  pemToArrayBuffer,
  toBase64Url,
} from "../src/email";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const pemNormal = readFileSync("/tmp/test_key.pem", "utf-8");
  const pemOneLine = readFileSync("/tmp/test_key_oneline.txt", "utf-8");

  // 1. Beide PEM-Varianten ergeben dieselben Bytes.
  const bufNormal = Buffer.from(pemToArrayBuffer(pemNormal));
  const bufOneLine = Buffer.from(pemToArrayBuffer(pemOneLine));
  check("pemToArrayBuffer: echte Newlines == literale \\n", bufNormal.equals(bufOneLine));

  // 2. Signatur mit unserem Code erzeugen ...
  const signingInput = "header.claims-testinput";
  const key = await importPrivateKey(pemNormal);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  // 3. ... und unabhängig mit Node's eingebautem crypto verifizieren.
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const isValid = verifier.verify(pemNormal, Buffer.from(signature));
  check("RS256-Signatur ist mit dem öffentlichen Schlüssel verifizierbar", isValid);

  // 4. toBase64Url liefert URL-sicheres, unpadded Base64.
  const b64url = toBase64Url("test?data+här");
  check(
    "toBase64Url enthält keine +, / oder = Zeichen",
    !/[+/=]/.test(b64url),
    b64url
  );

  // 5. RFC2047-Kodierung für Umlaute, ASCII bleibt unverändert.
  check("encodeHeaderValue lässt reines ASCII unverändert", encodeHeaderValue("Re: Termin") === "Re: Termin");
  const encoded = encodeHeaderValue("Rückfrage zu Ihrem Termin");
  check(
    "encodeHeaderValue kodiert Umlaute als RFC2047 (=?UTF-8?B?...?=)",
    /^=\?UTF-8\?B\?.+\?=$/.test(encoded),
    encoded
  );

  // 6. RFC2822-Nachricht enthält alle Pflichtfelder.
  const raw = buildRawMessage({
    fromEmail: "helpdesk@beglingerpartners.com",
    fromName: "Viridis",
    to: "kunde@example.com",
    subject: "Rückfrage",
    text: "Hallo, danke für Ihre Nachricht.",
  });
  check("buildRawMessage enthält From/To/Subject", /From:.*To:.*Subject:/s.test(raw));
  check("buildRawMessage enthält den Nachrichtentext", raw.includes("Hallo, danke für Ihre Nachricht."));

  console.log(failures === 0 ? "\nAlle Crypto-Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
