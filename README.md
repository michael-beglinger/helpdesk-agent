# Viridis — Helpdesk-Klassifizierungsdienst

Cloudflare Worker, der per Cron-Trigger alle 5 Minuten neue Karten in der
Trello-Liste **"Inbox Viridis (Agent)"** (Board *Support – Beglinger Partners
& Lifted*) prüft, klassifiziert und je nach Ergebnis automatisch beantwortet
oder ans Team eskaliert.

Gehört zu: `Viridis_Architektur_Trello.docx`, `Viridis_Klassifizierungsregeln.docx`,
`Viridis_Domain_Label_Mapping.xlsx`, `Viridis_Persona_Tonalitaet.docx`
(gleicher Kontext, siehe diese Dokumente für den fachlichen Hintergrund).

## Ablauf pro Lauf

1. Karten aus der Inbox-Liste ohne Kategorie-Label = unbearbeitet.
2. Absenderadresse/-domain aus der Karte extrahieren (`src/parse.ts`).
3. Klassifizierung per Anthropic-API: Kategorie, Konfidenz, Dringlichkeit,
   System-Benachrichtigung ja/nein (`src/classify.ts`).
4. Kunden-Label per Domain-Zuordnung (`src/config.ts`) setzen — kein
   LLM-Aufruf nötig, reiner Tabellen-Lookup.
5. Labels auf die Karte anwenden.
6. Je nach Ergebnis:
   - **System-Benachrichtigung** → Karte nach „Done", kein Kundenkontakt.
   - **Standard + Konfidenz ≥ 85 % + Absenderadresse bekannt** → Antwort im
     Viridis-Ton generieren (`src/reply.ts`), per E-Mail versenden
     (`src/email.ts`), Karte nach „Done", Antwort als Kommentar protokolliert
     **und zusätzlich für die Tageszusammenfassung vorgemerkt** (`src/digest.ts`).
   - **alles andere** → Karte nach „Escalated by Viridis", Begründung als
     Kommentar für das Team, **plus sofortige Slack-Benachrichtigung**
     (`src/slack.ts`).

## WhatsApp Business (Antwortvorschlag, kein Autoversand)

Zusätzlich zur E-Mail-Inbox prüft derselbe 5-Minuten-Cron die Liste
**"WhatsApp Inbox (Agent)"**. Diese Karten werden **manuell** angelegt (kein
Webhook, keine WhatsApp-Business-API-Anbindung): sobald ein Kunde eine
Support-Nachricht an WhatsApp Business schickt, legt jemand aus dem Team eine
Karte an mit

- **Name:** `<Kunde> – New WhatsApp Request`
  Wichtig: `<Kunde>` muss (Gross-/Kleinschreibung egal) exakt einem
  Kunden-Namen aus `CUSTOMER_LABELS` in `src/config.ts` entsprechen (aktuell
  z.B. "Richmond Events", "tide ocean", "Runge Pharma", "Internal", "Beni
  Huggel", "NGIB") und durch " – " (Leerzeichen-Gedankenstrich-Leerzeichen;
  Bindestrich "-" oder Halbgeviertstrich "—" funktionieren ebenfalls) vom
  Rest des Titels getrennt sein. Ohne diesen Trenner oder bei einem nicht
  zugeordneten Namen wird kein Kunden-Label gesetzt und ein Warnkommentar an
  der Karte hinterlassen.
- **Beschreibung:** der reine Nachrichtentext, unverändert eingefügt.

Ablauf pro Karte (`processWhatsAppCard` in `src/index.ts`):

1. Klassifizierung per Anthropic-API (`classifyWhatsAppMessage` in
   `src/classify.ts`) — gleiches Kategorien-/Dringlichkeits-Schema wie E-Mail,
   aber ohne Absenderdomain/System-Benachrichtigungs-Erkennung über bekannte
   Vendor-Domains (bei WhatsApp nicht anwendbar).
2. Kategorie- und Dringlichkeits-Label setzen sowie Kunden-Label anhand des
   Kartentitels (`<Kunde> – ...`, case-insensitiver Abgleich gegen
   `CUSTOMER_LABELS`) — siehe `extractCustomerNameFromWhatsAppCard` in
   `src/parse.ts`. Keine Telefonnummer-Zuordnung.
3. Antwortvorschlag generieren (`generateWhatsAppReplySuggestion` in
   `src/reply.ts`) und als Kommentar auf der Karte hinterlegen — **wird nie
   automatisch verschickt**. Ein Mitarbeiter kopiert den Vorschlag manuell in
   WhatsApp Business.
4. Karte nach "Backlog" verschieben (gleiche Liste, die auch E-Mail-System-
   Benachrichtigungen erhält) und Eintrag für die Tageszusammenfassung
   vermerken (Status `vorschlag`).

Das Tages-Limit `DAILY_TICKET_LIMIT` für Anthropic-Aufrufe gilt kanalübergreifend
für E-Mail und WhatsApp gemeinsam (ein gemeinsamer Zähler in `VIRIDIS_LOG`).

Zusätzlich läuft einmal täglich um 18 Uhr (Schweizer Zeit) ein zweiter
Cron-Trigger, der eine E-Mail mit allen seit dem letzten Lauf bearbeiteten
echten Support-Anfragen (automatisiert beantwortet UND eskaliert, jeweils
mit Trello-Link) an `DIGEST_RECIPIENT` schickt. Automatisch erkannte
System-/Vendor-Benachrichtigungen (Fall 1) zählen bewusst nicht als
Support-Anfrage und tauchen im Digest nicht auf.

## Einmalige Einrichtung

### 1. Abhängigkeiten installieren

```bash
npm install
```

### 2. Trello-API-Zugang

1. API-Key holen: https://trello.com/power-ups/admin (oder https://trello.com/app-key)
2. Token generieren (Link auf derselben Seite, verknüpft den Key mit dem
   Trello-Account, der Zugriff auf das Board hat).

### 3. Anthropic-API-Key

Aus der Anthropic Console (https://console.anthropic.com/).

### 4. Gmail API (Versand als helpdesk@beglingerpartners.com)

Bereits erledigt (Stand dieses Setups):

1. Google-Cloud-Projekt "Viridis Helpdesk Agent" angelegt.
2. Gmail API im Projekt aktiviert.
3. Dienstkonto `viridis-helpdes@extreme-voice-503608-s7.iam.gserviceaccount.com`
   erstellt, JSON-Key heruntergeladen (liegt lokal bei dir, nicht im Repo).
4. Domainweite Delegation in der Google Workspace Admin-Konsole
   (Sicherheit → API-Steuerung → Domainweite Delegierung) für die Client-ID
   `110040325863533380238` mit dem Scope
   `https://www.googleapis.com/auth/gmail.send` eingerichtet.

Aus der heruntergeladenen JSON-Datei werden zwei Werte als Secrets gebraucht
(siehe Schritt 5): das Feld `client_email` und das Feld `private_key`.

> Falls das Dienstkonto einmal neu aufgesetzt werden muss: Google-Cloud-Konsole
> → IAM und Verwaltung → Dienstkonten → Schlüssel → Neuen Schlüssel erstellen
> (JSON). Falls dabei "Das Erstellen von Dienstkontoschlüsseln ist deaktiviert"
> erscheint, muss ein Organisationsadministrator die Regel
> `iam.managed.disableServiceAccountKeyCreation` für das Projekt lockern
> (Google Cloud Console zeigt dafür einen direkten Link an).

### 5. Slack-Benachrichtigung (Eskalationen)

1. In Slack: https://api.slack.com/apps → "Create New App" → "From scratch".
2. Namen vergeben (z. B. "Viridis") und den Workspace auswählen.
3. Im Menü der App: "Incoming Webhooks" öffnen, oben rechts aktivieren
   ("Activate Incoming Webhooks").
4. Unten auf der Seite: "Add New Webhook to Workspace", den gewünschten
   Kanal auswählen (z. B. #support oder #helpdesk), erlauben.
5. Die angezeigte Webhook-URL (beginnt mit
   `https://hooks.slack.com/services/...`) kopieren — sie wird im nächsten
   Schritt als Secret gesetzt.

Diese URL wirkt wie ein Passwort: Wer sie kennt, kann Nachrichten in den
gewählten Kanal posten. Deshalb als Secret (nicht in `wrangler.toml`)
speichern.

### 6. KV-Namespace für die Tageszusammenfassung anlegen

```bash
npx wrangler kv namespace create VIRIDIS_LOG
```

Falls dieser Befehl einen Fehler zeigt (ältere wrangler-Version), stattdessen:

```bash
npx wrangler kv:namespace create VIRIDIS_LOG
```

Die Ausgabe enthält eine Zeile mit einer `id = "..."`. Diese id in
`wrangler.toml` beim Eintrag `[[kv_namespaces]]` anstelle von
`BITTE_MIT_ECHTER_KV_NAMESPACE_ID_ERSETZEN` einsetzen.

### 7. Secrets setzen

```bash
npx wrangler login
npx wrangler secret put TRELLO_API_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put ADMIN_TOKEN   # optional, nur für den manuellen fetch-Handler
```

Bei `GOOGLE_SERVICE_ACCOUNT_EMAIL` den Wert des Felds `client_email` aus der
JSON-Datei eingeben (z. B. `viridis-helpdes@extreme-voice-503608-s7.iam.gserviceaccount.com`).

Bei `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` den kompletten Wert des Felds
`private_key` aus derselben Datei einfügen — inklusive `-----BEGIN PRIVATE
KEY-----` und `-----END PRIVATE KEY-----`. Ob die Zeilenumbrüche darin als
echte Umbrüche oder als `\n`-Zeichenfolgen eingefügt werden, spielt keine
Rolle, der Code kommt mit beidem zurecht.

### 8. Deployen

```bash
npm run deploy
```

Beide Cron-Trigger (`*/5 * * * *` alle 5 Minuten, `0 16 * * *` für die
Tageszusammenfassung) sind in `wrangler.toml` konfiguriert und werden beim
Deploy automatisch aktiv.

**Wichtig — Sommer-/Winterzeit:** `0 16 * * *` ist eine UTC-Zeit und
entspricht 18:00 Schweizer Sommerzeit (MESZ, UTC+2). Während der
Winterzeit (MEZ, UTC+1) kommt die Mail dadurch um 17:00 Uhr statt 18:00 Uhr.
Cloudflare Cron-Trigger können keine Zeitzonen, nur feste UTC-Zeiten. Um es
exakt zu halten, den Wert zweimal im Jahr manuell anpassen (auf `0 17 * * *`
zur Winterzeit, zurück auf `0 16 * * *` zur Sommerzeit) und neu deployen —
oder die 1-Stunden-Abweichung im Winter einfach in Kauf nehmen.

**Digest manuell testen**, ohne bis 18 Uhr zu warten: die Worker-URL mit
`?digest=1` und dem Header `X-Viridis-Token` aufrufen (siehe Abschnitt
"Sicherheit"). Ohne gesetztes `ADMIN_TOKEN`-Secret ist dieser Endpunkt
deaktiviert.

## Lokal testen

```bash
cp .dev.vars.example .dev.vars   # und Werte eintragen
npm run dev
```

`wrangler dev` startet einen lokalen Server; ein Aufruf der angezeigten URL im
Browser oder per `curl` löst einen Durchlauf aus (siehe `fetch`-Handler in
`src/index.ts` — nützlich zum Testen, im Cron-Betrieb nicht nötig).

## Sicherheit: Prompt-Injection und Vertrauensgrenzen

Kartentitel und -beschreibung stammen vollständig vom externen Absender.
Deshalb gelten folgende Schutzmassnahmen (Stand September 2026):

- **Absender-Verifikation** (`src/parse.ts`): Eine Adresse gilt nur als
  verifiziert, wenn sie aus einer `From:`/`Von:`-Zeile in den ersten vier
  Zeilen der Beschreibung stammt (Header-Block von Trellos "E-Mail an
  Board"). Adressen irgendwo im Text sind fälschbar und werden nur zur
  Anzeige verwendet. Sobald das echte Kartenformat bekannt ist, sollte die
  Verifikation ausschliesslich aus dem Header-Feld abgeleitet werden.
- **Autoversand nur bei verifiziertem, bekanntem Kunden** (`src/index.ts`):
  zusätzlich zu Standard-Kategorie und Konfidenz muss der Absender
  verifiziert UND in `DOMAIN_TO_CUSTOMER_LABEL` sein. Damit kann eine
  präparierte Mail keine Antwort von `helpdesk@` an Dritte auslösen.
- **System-Benachrichtigung nur bei verifizierter Vendor-Domain**: Sonst
  Eskalation statt stillem Backlog.
- **`injection_verdacht`** im Klassifizierungs-JSON: erkennt Anweisungen an
  Assistenten, Aufforderungen zu Links/Zahlungs-/Kontaktdaten, Rollenwechsel.
  `true` erzwingt Eskalation und wird im Trello-Kommentar ausgewiesen.
- **Notausgang für das Modell**: Der Antwortgenerator darf statt eines Texts
  `ESCALATE` zurückgeben; der Code eskaliert dann.
- **Output-Guard vor dem Versand** (`src/guard.ts`): Antwort wird verworfen
  und eskaliert, wenn sie URLs, IBAN-/Kartennummern, Krypto-Adressen oder
  Telefonnummern enthält, die Pflichtsignatur fehlt oder die Länge
  ausserhalb 40–2500 Zeichen liegt.
- **Header-Injection**: Subject/Anzeigename werden von Zeilenumbrüchen
  bereinigt, der Empfänger muss eine einzelne reine Adresse sein.
- **Fehlversuchs-Limit pro Karte** (`MAX_CARD_ATTEMPTS`, Default 3) und
  Tageszähler *vor* dem Modellaufruf: Eine Karte, die das Modell zu
  Nicht-JSON verleitet, kann keine unbegrenzten API-Kosten erzeugen.
- **fetch-Handler geschützt**: ohne Secret `ADMIN_TOKEN` deaktiviert (404);
  mit Secret muss der Header `X-Viridis-Token` gesetzt sein. Manueller
  Digest-Test also mit:
  `curl -H "X-Viridis-Token: <token>" "https://viridis-helpdesk.beglingerpartners.workers.dev/?digest=1"`

Neues Secret setzen: `npx wrangler secret put ADMIN_TOKEN` (z. B. Ausgabe
von `openssl rand -hex 32`).

## Unbedingt vor dem produktiven Einsatz prüfen

- **Kartenformat der eingehenden E-Mails**: `src/parse.ts` versucht, die
  Absenderadresse aus Betreff/Beschreibung zu extrahieren, aber das genaue
  Format von Trellos "E-Mail an Board"-Karten war zum Zeitpunkt der
  Entwicklung nicht mit einer echten Test-Mail verifizierbar. Bitte mit den
  ersten echten Testfällen (siehe `Viridis_Workflow_Helpdesk.docx`,
  Abschnitt 6 "Testphase") gegenprüfen und `parse.ts` bei Bedarf anpassen.
- **Label "Unbekannt/Neu"**: existiert aktuell nicht in Trello. Absender ohne
  Domain-Treffer bekommen aktuell nur einen Warn-Kommentar, aber kein
  Kunden-Label. Falls gewünscht, Label anlegen und ID in `src/config.ts`
  ergänzen.
- **Duplikate/Rennbedingungen**: Der Dienst erkennt "bearbeitet" daran, dass
  ein Kategorie-Label gesetzt ist. Läuft ein zweiter Durchlauf, während der
  erste eine Karte noch verarbeitet (z. B. bei einem sehr kurzen Cron-Takt),
  könnte dieselbe Karte doppelt angefasst werden. Bei 5-Minuten-Takt und dem
  aktuellen Anfragevolumen unwahrscheinlich, aber im Auge behalten.
- **Automatisierungsschwelle**: `AUTOMATION_CONFIDENCE_THRESHOLD` (aktuell
  0.85) in `wrangler.toml` nach der Testphase ggf. nachjustieren.
- **Digest-Cron und Sommer-/Winterzeit**: siehe Hinweis in Abschnitt 8
  "Deployen" — `0 16 * * *` ist nur zur Sommerzeit exakt 18 Uhr.

## Projektstruktur

```
src/
  config.ts   Board-/Listen-/Label-IDs, Domain-Mapping (kein Secret)
  types.ts    gemeinsame TypeScript-Typen
  parse.ts    Absender-Extraktion aus der Trello-Karte
  trello.ts   Trello-REST-API-Wrapper
  classify.ts Anthropic-Klassifizierung
  reply.ts    Anthropic-Antwortgenerierung im Viridis-Ton
  email.ts    Versand über die Gmail API (Dienstkonto, domainweite Delegation)
  slack.ts    Sofortige Slack-Benachrichtigung bei Eskalationen (Incoming Webhook)
  digest.ts   Protokollierung automatisierter Antworten (KV) + tägliche Zusammenfassungs-Mail
  index.ts    Scheduled-Handler, verknüpft alles, unterscheidet die zwei Cron-Trigger
test/
  run-tests.ts  Tests für die reine Logik, ohne Live-API-Aufrufe (`npm test`)
```

