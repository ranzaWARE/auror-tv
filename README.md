# AUROR TV

**La Home della TV LG, in stile AUROR.** Una versione di [Glasshouse](https://github.com/rorygallagher2024/glasshouse) tutta in italiano, con una Home ispirata ad Apple TV e il design system AUROR.

Gira direttamente su una TV LG webOS con root, senza servizi cloud. Pensata per un OLED65G66LS con webOS 11.2 (LG's webOS 26); le funzioni di Glasshouse restano tutte disponibili.

[Prova la demo](https://ranzaware.github.io/auror-tv/demo/) · [Documentazione](https://ranzaware.github.io/auror-tv/) · [Ultima release](https://github.com/ranzaWARE/auror-tv/releases/latest)

## Cosa aggiunge a Glasshouse

- **Tutto in italiano:** dashboard, Home, app sulla TV e messaggi del server.
- **Home in stile Apple TV:** in alto una fascia grande mostra il riquadro selezionato. Per Jellyfin ci sono "Continua a guardare" o "Aggiunti di recente", per gli ingressi HDMI il dispositivo collegato, per le altre app i loro colori e una riga su cosa sono. Le app sono banner 16:9 a colori con il logo del marchio.
- **Saluto e barra in alto:** un saluto col tuo nome che cambia ogni volta, e accanto all'ora i tasti per cerca, rete (con il pallino verde, arancio o rosso), timer di spegnimento, tema, impostazioni e spegnimento.
- **Ricerca:** dice dove vedere un film o una serie in Italia, tra Jellyfin e i servizi di streaming, senza passare da LG.
- **Sfondi:** foto caricate dal telefono o dal computer nella rete di casa, una fissa o a rotazione.
- **Immich:** album, foto e video sulla TV, i ricordi di oggi sulla fascia in alto e le foto come salvaschermo.
- **Altre app:** una cartella per le app che non servono sempre, senza nasconderle.
- **Tema chiaro e scuro:** chiaro dalle 6:00 alle 17:00, scuro dalle 17:00. Un pulsante lo cambia fino al passaggio successivo.
- **Anti burn-in:** tutta la pagina si sposta lentamente di pochi pixel e non ci sono scritte fisse.
- **Impostazioni dalla TV e dal browser:** tema, nome, salvaschermo, mascotte, fascia in alto, app visibili, sfondi, SSH. Jellyfin, TMDB e Immich si collegano dal telefono con un codice QR.
- **Salvaschermo per OLED:** orologio su nero con Mimus che dorme, oppure le foto di Immich.
- **Mimus e Quetza:** le due mascotte in pixel art attraversano ogni tanto la Home.
- **Aggiornamenti automatici:** ogni release di Glasshouse viene unita ad AUROR e la TV la installa da sola, a TV spenta o di notte.

## Installazione

1. Root della TV e [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel), poi Glasshouse come da [guida](https://ranzaware.github.io/auror-tv/install/).
2. Dalla dashboard di Glasshouse, scheda **App** › **Install app from a URL or file**: il file `.ipk` dell'[ultima release di AUROR](https://github.com/ranzaWARE/auror-tv/releases/latest), installato sopra Glasshouse.
   In alternativa, da un clone di questo repository: `./deploy.sh <ip-tv>` dalla cartella `server/`.
3. Aprire `http://<ip-tv>:8080/` nel browser. Su webOS 11 Glasshouse Home è sperimentale e va abilitata con `"allowExperimentalHome": true` in `config.json`.

Da lì AUROR si aggiorna da solo; **Impostazioni › Glasshouse › Aggiorna ora** lo aggiorna subito. Dopo l'installazione conviene [passare da telnet a SSH](https://ranzaware.github.io/auror-tv/SECURITY/#moving-from-telnet-to-ssh).

## Il resto di Glasshouse

Controllo della TV senza cloud, privacy e blocco della pubblicità, gestione delle app, cura del pannello OLED, menu di servizio, metriche e integrazione con Home Assistant: tutto come in Glasshouse. La [documentazione](https://ranzaware.github.io/auror-tv/) le descrive una per una; le pagine sono anche in [docs/](docs/).

## Sicurezza

La dashboard non ha autenticazione di default ed è pensata per la rete di casa. **Non esporre mai la porta 8080 su internet.** [Security](https://ranzaware.github.io/auror-tv/SECURITY/) spiega il token e come chiudere la porta alla rete.

## Avvertenze

**Uso a proprio rischio.**

* **Root e hardware.** Il software gira con privilegi `root` sul sistema della TV. Nessuna responsabilità per danni, blocchi, TV inutilizzabili, garanzia, perdita di dati o problemi al pannello.
* **Marchi.** Progetto indipendente e non ufficiale, non affiliato né approvato da LG Electronics. webOS è un marchio di LG Electronics. I loghi dei banner vengono da [Simple Icons](https://simpleicons.org/) (CC0-1.0) e, per Disney+, da [Streamline](https://github.com/webalys-hq/streamline-vectors) (CC BY 4.0), e restano marchi dei rispettivi proprietari. Immich è un marchio dei suoi autori.
* **Font.** Include [Outfit](https://github.com/Outfitio/Outfit-Fonts), [Manrope](https://github.com/sharanda/manrope), [Space Grotesk](https://github.com/floriankarsten/space-grotesk) e [Space Mono](https://github.com/googlefonts/spacemono) con licenza [SIL Open Font License 1.1](https://openfontlicense.org/); le licenze sono in `server/assets/fonts/`.

## Crediti e licenza

Basato su [Glasshouse](https://github.com/rorygallagher2024/glasshouse) di rorygallagher2024, che si può [sostenere qui](https://buymeacoffee.com/rorygallagher2024). Design system AUROR e mascotte Mimus e Quetza di ranzaWARE.

MIT. Vedi [LICENSE](LICENSE).
