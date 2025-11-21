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

## Komplett lokale Installation in Oracle VirtualBox (Ubuntu 24.04)

Die folgende Schritt-für-Schritt-Anleitung führt dich von einer leeren VirtualBox-Installation bis zum laufenden Spiel innerhalb einer Ubuntu-24.04-VM.

### 1) Vorbereitung: Ubuntu-ISO besorgen
1. Lade das aktuelle Ubuntu Desktop 24.04 ISO herunter: <https://ubuntu.com/download/desktop>.
2. Merke dir den Speicherort der ISO auf deinem Hostsystem (z. B. `~/Downloads/ubuntu-24.04-desktop-amd64.iso`).

### 2) Neue VM in VirtualBox anlegen
1. Starte VirtualBox → **Neu**.
2. Gib einen Namen ein (z. B. „1gegen100“) und wähle als ISO das heruntergeladene Ubuntu-Image.
3. Wähle den Typ „Linux“ und Version „Ubuntu (64-bit)“.
4. Weise mindestens 2–4 CPU-Kerne, 4 GB RAM (besser 8 GB) und eine virtuelle Festplatte mit 30 GB (VDI, dynamisch alloziert) zu.
5. Aktiviere in den **Netzwerk**-Einstellungen den Modus „Netzwerkbrücke“ oder „NAT“ mit Port-Weiterleitung:
   - **Bridged**: VM erhält eine IP im gleichen Netz wie dein Host; Zugriff auf `http://<VM-IP>:3000`.
   - **NAT mit Port-Forwarding**: Lege eine Regel an (z. B. Host-Port 3000 → Gast-Port 3000), damit dein Host auf das Backend zugreifen kann.

### 3) Ubuntu 24.04 installieren
1. Starte die VM, folge dem Installationsassistenten („Try or Install Ubuntu“ → „Install Ubuntu“).
2. Wähle Tastaturlayout, Standardinstallation, automatische Updates nach Bedarf.
3. Erstelle einen Benutzer mit Passwort; aktiviere „Install third-party software“ (Grafik/WLAN) falls angeboten.
4. Nach Abschluss neu starten und das ISO auswerfen (VirtualBox fragt automatisch).

### 4) Erste Systemschritte in der VM
1. Melde dich an und öffne ein Terminal.
2. Aktualisiere das System:
   ```bash
   sudo apt update
   sudo apt upgrade -y
   ```
3. Installiere Hilfstools:
   ```bash
   sudo apt install -y curl git
   ```

### 5) Node.js 20 LTS installieren
Ubuntu 24.04 liefert Node 18; das Projekt läuft stabil mit Node 18+, empfohlen wird 20.
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # sollte 20.x anzeigen
npm -v
```

### 6) Projektcode in die VM holen
1. Wähle einen Arbeitsordner, z. B. `~/1gegen100`:
   ```bash
   mkdir -p ~/1gegen100
   cd ~/1gegen100
   ```
2. Hole den Code hinein – entweder per `git clone`:
   ```bash
   git clone <dein-git-url> .
   ```
   oder kopiere die Dateien per Shared Folder/SFTP in diesen Ordner.

### 7) Backend installieren und starten
1. Wechsel ins Backend und installiere Abhängigkeiten:
   ```bash
   cd ~/1gegen100/backend
   npm install --production
   ```
2. Starte das Backend (Standardport 3000):
   ```bash
   npm start
   ```
   Lass das Terminal offen; die Konsole zeigt „Server läuft auf Port 3000“. Innerhalb der VM erreichst du das Backend unter `http://localhost:3000`.

### 8) Frontend lokal aufrufen
1. Öffne in der VM den Dateimanager → Ordner `~/1gegen100/frontend`.
2. Doppelklicke `index.html` (Spieler), `admin.html`, `display.html` oder `presentation.html`.
3. Der Browser lädt die Datei via `file://...`; `socket-config.js` fällt automatisch auf `http://localhost:3000` zurück und verbindet sich mit dem laufenden Backend.

### 9) Zugriff vom Host auf die VM (optional)
* **Bridged-Netzwerk**: Ermittele die VM-IP (`ip addr` im Terminal) und öffne auf dem Host `http://<VM-IP>:3000` für Backend oder die lokal gehosteten Frontend-Seiten (`file://` innerhalb der VM). Für die Frontend-Seiten kannst du sie auch direkt im VM-Browser öffnen und bedienen.
* **NAT mit Port-Forwarding**: Richte in VirtualBox eine Regel ein (Host 3000 → Gast 3000). Dann erreichst du das Backend von deinem Host unter `http://localhost:3000`; die Frontend-HTMLs kannst du ebenfalls auf dem Host öffnen, müssen aber per `<script>window.__SOCKET_URL__='http://localhost:3000';</script>` vor `socket-config.js` auf das weitergeleitete Backend zeigen, falls du sie außerhalb der VM nutzen willst.

### 10) Tipps für komfortablen Betrieb
* Wenn du mehrere Clients brauchst, öffne einfach mehrere Browserfenster/Tabs in der VM (oder auf dem Host, wenn du Port-Forwarding nutzt).
* Möchtest du die HTML-Seiten aus der VM per Browser im Host aufrufen, kannst du im Projektstamm temporär einen einfachen Server starten:
  ```bash
  cd ~/1gegen100
  npx serve frontend
  ```
  Damit sind die Seiten in der VM unter `http://localhost:5000` verfügbar; bei Bridged oder Port-Forwarding auch vom Host. Dank Socket-Fallback verbinden sie sich trotzdem mit `localhost:3000` (bzw. der weitergeleiteten Hostadresse), sofern du keinen eigenen `window.__SOCKET_URL__` setzt.

Damit kannst du das Spiel von null an in einer frisch erzeugten Ubuntu-24.04-VM auf VirtualBox aufsetzen und entweder ausschließlich dort oder auch vom Host aus nutzen.
