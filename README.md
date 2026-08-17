# WoL Auto

SPA local para **Wake on LAN** com descoberta automática de dispositivos na rede.

## Como funciona

Um SPA rodando só no navegador não consegue escanear a rede local nem enviar
pacotes UDP de broadcast (magic packets) — isso é bloqueado pelo sandbox de
segurança do browser. Por isso este projeto tem duas partes:

- **Backend (Node.js/Express)** — roda localmente, na mesma rede dos
  dispositivos que você quer acordar. Ele:
  - detecta a(s) sub-rede(s) IPv4 locais da máquina;
  - faz um *ping sweep* na sub-rede para popular a tabela ARP do sistema
    operacional e depois lê essa tabela (`arp -a`) para descobrir pares
    IP ↔ MAC de tudo que respondeu;
  - tenta resolver o hostname de cada IP via DNS reverso (melhor esforço);
  - guarda os dispositivos encontrados em `devices.json`, mesclando com o
    que já foi visto antes (assim, mesmo que o aparelho seja desligado
    depois, o MAC continua salvo para poder acordá-lo via WoL);
  - envia o *magic packet* (UDP broadcast na porta 9) quando você clica em
    "Acordar".
- **Frontend (SPA em HTML/CSS/JS puro)** — interface que lista os
  dispositivos, mostra status online/offline, permite renomear, remover,
  adicionar manualmente (para aparelhos que estão desligados e por isso
  não aparecem numa varredura) e disparar o Wake on LAN.

> **Importante:** o app descobre automaticamente todo dispositivo que tem um
> endereço MAC visível na rede — que são exatamente os dispositivos possíveis
> de receber um magic packet. Não existe forma de, remotamente, confirmar que
> o **Wake on LAN está habilitado** na placa de rede / BIOS de um aparelho de
> terceiros; isso é uma configuração que precisa estar ativada no próprio
> dispositivo (Windows: opção "Permitir que este dispositivo acorde o
> computador" nas propriedades do adaptador de rede + WoL habilitado na BIOS).

## Rodando

```bash
npm install
npm start
```

Depois abra `http://localhost:3000` no navegador **da mesma máquina/rede**
onde o servidor está rodando (ele precisa estar na mesma LAN dos
dispositivos-alvo para o ping sweep e o broadcast funcionarem).

Clique em **"Escanear rede"** para descobrir automaticamente os dispositivos
ligados agora. Para aparelhos que estarão desligados no momento do scan, use
**"Adicionar manualmente"** informando nome + MAC (e IP se souber) — assim o
WoL funciona mesmo sem eles terem aparecido numa varredura.

## Notas técnicas

- Funciona em Windows, Linux e macOS (usa `ping`/`arp` nativos do SO).
- A varredura é limitada à(s) sub-rede(s) diretamente conectada(s) à máquina
  que roda o servidor (não atravessa roteadores/VLANs).
- Para acordar um PC pela internet (fora da LAN), seria necessário port
  forwarding do UDP/9 no roteador para o broadcast da rede — fora do escopo
  deste projeto, que foi pensado para uso na rede local.

## Docker

O `docker-compose.yml` usa a imagem já publicada no Docker Hub
(`pajeritmia/wol-auto`, gerada automaticamente pelo GitHub Actions a cada
push — veja a seção de CI/CD abaixo), então não builda nada localmente:

```bash
docker compose pull
docker compose up -d
```

Isso também é o que você cola direto no editor do Portainer (Stacks → Web
editor) para subir o stack sem precisar do Dockerfile/código-fonte no host.

App fica disponível em `http://localhost:8099` (ou `http://<ip-da-maquina>:8099`,
já que o compose usa `network_mode: host` para o ping sweep, ARP e o
broadcast do magic packet alcançarem a LAN de verdade — em modo bridge
padrão do Docker isso normalmente não funciona). Detalhes e alternativas
estão comentados em [docker-compose.yml](docker-compose.yml).

Para buildar a imagem localmente a partir do código-fonte (ex: para testar
uma mudança antes de fazer push), use o `Dockerfile` diretamente:

```bash
docker build -t wol-auto:local .
docker run --rm -it --network host -e PORT=8099 wol-auto:local
```

Os dispositivos cadastrados persistem no volume nomeado `wol-data`
(`/app/data/devices.json` dentro do container).

### Interface de rede errada dentro do Docker

Com `network_mode: host` o container enxerga **todas** as interfaces do
host, inclusive as virtuais que o próprio Docker cria (`docker0`, `br-*`,
`veth*`, etc.) — elas são filtradas automaticamente e não entram na
varredura. Se ainda assim a interface detectada não for a da sua LAN
física, force manualmente pelo nome exato da interface via variável de
ambiente `NETWORK_IFACE` (ex: `eth0`, `ens160`) — veja o exemplo comentado
em [docker-compose.yml](docker-compose.yml). O nome correto aparece em
`ip addr` (Linux) rodado no host.

## CI/CD — publicação automática no Docker Hub

O workflow [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)
builda a imagem (multi-arch `linux/amd64` + `linux/arm64`) e publica no
Docker Hub como `<seu-usuario>/wol-auto` a cada push na branch `main` ou tag
`vX.Y.Z`. Em pull requests ele só builda (sem publicar), como validação.

Para funcionar, cadastre dois **secrets** no repositório do GitHub
(*Settings → Secrets and variables → Actions → New repository secret*):

| Secret | Valor |
|---|---|
| `DOCKERHUB_USERNAME` | seu usuário do Docker Hub |
| `DOCKERHUB_TOKEN` | um *Access Token* do Docker Hub (não a senha da conta) — gere em Docker Hub → Account Settings → Security → New Access Token |

Tags geradas automaticamente: `latest` (branch `main`), `sha-<commit>`, e
`X.Y.Z` / `X.Y` quando você criar uma tag git `vX.Y.Z`.
