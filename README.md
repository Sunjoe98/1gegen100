# 1gegen100

## Lokaler Betrieb ohne eigene URL

So kannst du das Spiel komplett auf einem einzelnen Rechner laufen lassen, ohne eine Domain oder einen Webserver zu benötigen:

1. **Backend vorbereiten**
   - Öffne ein Terminal und wechsle in den Projektordner: `cd /pfad/zu/1gegen100/backend`.
   - Installiere die Abhängigkeiten (einmalig): `npm install`.
   - Starte den Socket.IO/Express-Server auf dem Standardport 3000: `npm start`. Das Backend bleibt im Terminal aktiv und ist unter `http://localhost:3000` erreichbar.

2. **Frontend lokal öffnen**
   - Lass den Backend-Prozess weiterlaufen.
   - Öffne im Dateimanager den Ordner `frontend/` und doppelklicke die gewünschte HTML-Datei (`index.html` für Spieler, `admin.html` usw.).
   - Der Browser lädt die Datei mit dem Schema `file://...`. `socket-config.js` erkennt automatisch, dass kein Host vorhanden ist, und verbindet sich daher mit `http://localhost:3000`.

3. **Optional: einfachen Dev-Server nutzen**
   - Falls dein Browser lokale `file://` Seiten restriktiv behandelt, kannst du im Projektstamm `npx serve frontend` oder `npx http-server frontend` ausführen und die Seiten unter `http://localhost:5000` o. Ä. öffnen. Dank des Fallbacks in `socket-config.js` verbinden sich auch diese Seiten ohne zusätzliche Konfiguration mit dem lokalen Backend.

4. **Mehrere Clients auf demselben Rechner**
   - Öffne einfach mehrere Browserfenster oder -tabs (z. B. eins für das Admin-Panel, eines für den Spieler). Alle nutzen automatisch `localhost` als Backend-Adresse.

Mit diesen Schritten brauchst du keine eigene URL: Backend und Frontend laufen komplett lokal, und die bestehenden Defaults des Projekts kümmern sich um die Verbindung.
