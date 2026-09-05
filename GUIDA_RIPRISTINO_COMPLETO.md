# GUIDA DI RIPRISTINO COMPLETO — LA MIA SPESA

## A. Ripristino della PWA

Questo branch è uno snapshot completo dell'app al 05/09/2026.

Commit sorgente congelato:
981f835f011a13e4d7516f6339c18a6c8351e7cd

Per ripristinare:
1. Scaricare il branch backup-completo-2026-09-05 come ZIP oppure clonarlo.
2. Creare un nuovo repository GitHub.
3. Caricare tutti i file del backup.
4. Pubblicare il repository con GitHub Pages.
5. Se necessario, aggiornare nel file js/app.js l'indirizzo del Worker.

## B. Ripristino del Cloudflare Worker

1. Cloudflare Dashboard → Workers & Pages.
2. Create Worker.
3. Nome consigliato: lista-spesa-master.
4. Copiare il contenuto di BACKUP_CLOUDFLARE/worker.js.
5. Aggiungere le quattro runtime variables indicate in configurazione.txt.
6. Impostare ADMIN_KEY come Secret.
7. Impostare GITHUB_TOKEN come Secret.
8. Deploy.
9. Se l'URL del nuovo Worker cambia, aggiornare MASTER_API_URL in js/app.js.

## C. GitHub Token

Il token deve avere i permessi necessari per leggere e aggiornare:
products-master.json

Se il vecchio token non è più disponibile, crearne uno nuovo con i permessi appropriati sul repository.

## D. Verifica finale

1. Aprire la PWA.
2. Controllare che la libreria Master venga letta.
3. In modalità amministratore, pubblicare una modifica di prova.
4. Verificare che products-master.json venga aggiornato su GitHub.
5. Su un secondo dispositivo, controllare la notifica dei nuovi prodotti e l'importazione.

## E. Cosa NON è contenuto nel backup

Per sicurezza non sono contenuti in chiaro:
- ADMIN_KEY
- GITHUB_TOKEN

Questi due Secret devono essere conservati separatamente o rigenerati.
