# Forex Confluence Alert Bot

Prüft deine Watchlist regelmäßig gegen die 4 Kernindikatoren (Pivot, RSI, MA200, Fibonacci)
und schickt dir eine Telegram-Nachricht, sobald **alle 4 Ampeln in dieselbe Richtung** zeigen
(Confluence-Score = +4 oder −4). Löst **keine echten Trades** aus — reine Benachrichtigung.

## Setup (einmalig, ca. 10 Minuten)

### 1. Telegram-Bot erstellen
1. In Telegram nach **@BotFather** suchen, `/newbot` senden, Namen vergeben
2. Du bekommst einen **Bot-Token** (sieht aus wie `123456:ABC-DEF...`) — kopieren
3. Deinem neuen Bot eine beliebige Nachricht schicken (z. B. "hi"), damit er deine Chat-ID kennt
4. Im Browser öffnen: `https://api.telegram.org/bot<DEIN_TOKEN>/getUpdates`
   → darin die Zahl bei `"chat":{"id": ...}` ist deine **Chat-ID**

### 2. GitHub-Repository anlegen
1. Auf github.com ein neues (privates) Repository erstellen
2. Diesen gesamten Ordner (`forex-alert-bot`) hochladen — z. B. per Drag & Drop im Browser
   (github.com/DEIN_NAME/DEIN_REPO → "Add file" → "Upload files")

### 3. Secrets hinterlegen
Im Repository: **Settings → Secrets and variables → Actions → New repository secret**
Drei Secrets anlegen:
- `TWELVE_DATA_API_KEY` → dein Twelve-Data-Key (derselbe wie im Panel)
- `TELEGRAM_BOT_TOKEN` → aus Schritt 1
- `TELEGRAM_CHAT_ID` → aus Schritt 1

### 4. Fertig
Der Bot läuft automatisch alle 30 Minuten (siehe `.github/workflows/forex-alert.yml`).
Manuell testen: Im Repository auf **Actions → Forex Confluence Alert → Run workflow**.

## Watchlist anpassen
In `scripts/check-alerts.js` ganz oben:

```js
const WATCHLIST = [
  { pair: "EUR/USD", timeframe: "4h" },
  { pair: "GBP/USD", timeframe: "4h" },
  // weitere Paare/Zeiteinheiten hinzufügen
];
```

Mögliche `timeframe`-Werte: `"1day"`, `"4h"`, `"1h"`, `"15min"`, `"5min"`.

**Achtung Rate Limit:** Twelve Data Free-Tier erlaubt ~8 Requests/Minute und 800/Tag.
Jedes Paar braucht 1–2 Requests. Bei vielen Einträgen ggf. den Cron-Rhythmus in der
`.yml`-Datei auf `*/60 * * * *` (stündlich) verringern.

## Wie die Ampel-Logik funktioniert
- **RSI:** < 30 bullisch, > 70 bärisch
- **MA200:** Kurs über EMA200 *und* SMA200 → bullisch, unter beiden → bärisch
- **Pivot:** Kurs über echtem Tages-Pivot → bullisch, darunter → bärisch
- **Fibonacci:** Kurs in der Golden Zone (50–61,8 %) **und** Trendrichtung passend → bullisch/bärisch

Alarm nur, wenn **alle vier gleichzeitig** in dieselbe Richtung zeigen. Nach einem Alarm
wird der Zustand gespeichert, damit du nicht bei jedem Durchlauf erneut benachrichtigt wirst —
erst wenn die Ampeln sich wieder ändern und danach erneut voll ausrichten, kommt der nächste Alarm.

## Zusätzliche Filter (Veto & Hinweis)
- **Zonen-Veto:** Wenn direkt im Weg (in Richtung des Signals) eine starke Widerstands-/Kaufzone
  liegt (< 15 Pips entfernt, einstellbar über `OBSTACLE_THRESHOLD_PIPS`), wird der Alarm unterdrückt —
  auch wenn der Score +4/−4 ist. Das reduziert Fehlsignale kurz vor einem Hindernis.
- **Notenbank-Hinweis:** Steht innerhalb der nächsten 24 Stunden eine Fed- (bei USD-Paaren) oder
  EZB-Sitzung (bei EUR-Paaren) an, wird das als reiner Hinweis an die Nachricht angehängt — kein
  Veto, nur zur Einordnung erhöhter Unsicherheit. Termine für 2026 sind statisch hinterlegt
  (Quelle: federalreserve.gov, ecb.europa.eu) und müssten für 2027 aktualisiert werden.

## Wichtiger Hinweis
Das ist ein regelbasiertes technisches Werkzeug, keine Anlageberatung und keine Erfolgsgarantie.
Ein "Score +4" bedeutet nur, dass vier einfache Regeln zufällig übereinstimmen — nicht, dass ein
Trade erfolgversprechend ist. Bitte nutze das als Ausgangspunkt für deine eigene Analyse.
