# MINI GUIDA DI EMERGENZA — La Mia Spesa V3.1

Questo backup permette di ricreare l'app su un nuovo repository GitHub e su un nuovo Cloudflare Worker.

## 1. Conserva il backup
Scarica lo ZIP del branch backup-v3.1 e conservalo su PC + supporto fisico.

## 2. Ricreare GitHub
1. Crea un nuovo repository GitHub.
2. Carica TUTTI i file della cartella principale di questo backup.
3. Mantieni la struttura delle cartelle (css/, js/ ecc.).
4. Imposta il branch principale su main.
5. In Settings > Pages pubblica il sito dal branch main.

## 3. Ricreare Cloudflare
1. Cloudflare > Workers & Pages > Create Worker.
2. Copia il codice da CLOUDFLARE/worker.js.
3. In Settings/Variables configura:
   - GITHUB_OWNER = MarrapodiStefano (oppure il nuovo proprietario)
   - GITHUB_REPO = lista-spesa (oppure il nuovo nome)
   - GITHUB_TOKEN = il tuo token GitHub
   - ADMIN_KEY = la chiave amministratore del Worker
4. Deploy del Worker.

## 4. Collegare la PWA al nuovo Worker
Se l'indirizzo del Worker cambia, cerca MASTER_API_URL nel file js/app.js e sostituiscilo con il nuovo indirizzo del Worker seguito da /master.

## 5. Controllo finale
- Apri la PWA dal nuovo GitHub Pages.
- Verifica che la Libreria Master sia presente.
- Prova l'aggiornamento della Libreria prodotti.
- Entra in modalità amministratore.
- Pubblica una modifica di prova.
- Verifica da un secondo dispositivo che il nuovo prodotto venga scaricato.

## IMPORTANTE
Il backup NON contiene segreti in chiaro:
- GITHUB_TOKEN
- ADMIN_KEY

Conservali separatamente in un luogo sicuro.
