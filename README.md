# AUROR TV

**La Home della TV LG, in stile AUROR.** Una versione di [Glasshouse](https://github.com/rorygallagher2024/glasshouse) tutta in italiano, con una Home ispirata ad Apple TV e il design system AUROR.

Gira direttamente su una TV LG webOS con root, senza servizi cloud. Pensata per un OLED65G66LS con webOS 11.2 (LG's webOS 26); le funzioni di Glasshouse restano tutte disponibili.

## Cosa aggiunge a Glasshouse

- **Tutto in italiano:** dashboard, Home, app sulla TV e messaggi del server.
- **Home in stile Apple TV:** in alto una fascia grande mostra il riquadro selezionato. Per Jellyfin ci sono "Continua a guardare" o "Aggiunti di recente", per Glasshouse temperatura, CPU, memoria e Wi-Fi della TV, per gli ingressi HDMI il dispositivo collegato. Le app sono banner 16:9 a colori con il logo del marchio; quello selezionato mostra il nome, si solleva e si ingrandisce.
- **Tema chiaro e scuro:** chiaro dalle 6:00 alle 17:00, scuro dalle 17:00. Un pulsante lo cambia fino al passaggio successivo.
- **Anti burn-in:** tutta la pagina si sposta lentamente di pochi pixel e non ci sono scritte fisse.
- **Impostazioni dalla TV:** dall'ingranaggio si scelgono tema, salvaschermo, mascotte, contenuti della fascia in alto e app visibili. Jellyfin si collega dal telefono con un codice QR.
- **Solo ciò che serve:** gli ingressi HDMI compaiono solo con un dispositivo collegato; Notifiche e Cerca di LG partono nascosti.
- **Salvaschermo AUROR:** orologio attenuato su nero, sempre in movimento.
- **Mimus e Quetza:** le due mascotte in pixel art attraversano ogni tanto la Home e il salvaschermo.

## Installazione

1. Root della TV e [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel), come per Glasshouse.
2. Clonare questo repository su un computer nella stessa rete della TV (su Windows con Git Bash).
3. Dalla cartella `server/`: `./deploy.sh <ip-tv>`.
4. Aprire `http://<ip-tv>:8080/` nel browser. Su webOS 11 Glasshouse Home è sperimentale e va abilitata con `"allowExperimentalHome": true` in `config.json`.

La [guida di installazione di Glasshouse](https://rorygallagher2024.github.io/glasshouse/install/) ha i dettagli. Dopo l'installazione conviene [passare da telnet a SSH](https://rorygallagher2024.github.io/glasshouse/SECURITY/#moving-from-telnet-to-ssh).

## Il resto di Glasshouse

Controllo della TV senza cloud, privacy e blocco della pubblicità, gestione delle app, cura del pannello OLED, menu di servizio, metriche e integrazione con Home Assistant: tutto come in Glasshouse. La [documentazione di Glasshouse](https://rorygallagher2024.github.io/glasshouse/) le descrive una per una; le pagine sono anche in [docs/](docs/).

## Sicurezza

La dashboard non ha autenticazione di default ed è pensata per la rete di casa. **Non esporre mai la porta 8080 su internet.** [Security](https://rorygallagher2024.github.io/glasshouse/SECURITY/) spiega il token e come chiudere la porta alla rete.

## Avvertenze

**Uso a proprio rischio.**

* **Root e hardware.** Il software gira con privilegi `root` sul sistema della TV. Nessuna responsabilità per danni, blocchi, TV inutilizzabili, garanzia, perdita di dati o problemi al pannello.
* **Marchi.** Progetto indipendente e non ufficiale, non affiliato né approvato da LG Electronics. webOS è un marchio di LG Electronics. I loghi dei banner vengono da [Simple Icons](https://simpleicons.org/) (CC0-1.0) e restano marchi dei rispettivi proprietari.
* **Font.** Include [Outfit](https://github.com/Outfitio/Outfit-Fonts), [Manrope](https://github.com/sharanda/manrope), [Space Grotesk](https://github.com/floriankarsten/space-grotesk) e [Space Mono](https://github.com/googlefonts/spacemono) con licenza [SIL Open Font License 1.1](https://openfontlicense.org/); le licenze sono in `server/assets/fonts/`.

## Crediti e licenza

Basato su [Glasshouse](https://github.com/rorygallagher2024/glasshouse) di rorygallagher2024, che si può [sostenere qui](https://buymeacoffee.com/rorygallagher2024). Design system AUROR e mascotte Mimus e Quetza di ranzaWARE.

MIT. Vedi [LICENSE](LICENSE).
