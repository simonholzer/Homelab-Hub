# Server stats and other machines

[← Back to the README](../README.md)

## The stats of the hub's own server

The tiles at the top show CPU, memory, load, network, uptime and storage of the machine the hub runs on. They are read
from the host's `/proc` and `/sys`, mounted read-only by `compose.yaml`.

- **Storage:** one tile per entry in `stats.disks`, each pointing at a folder mounted read-only into the container.
  Add one mount line per disk or pool in `compose.yaml` (e.g. `- /mnt/tank:/pools/tank:ro`) and one tile in the
  editor (*Machines*). A tile whose path isn't mounted says so, with the line to add. With `size:` (e.g.
  `size: 3.6T`) the tile shows used / total and a bar: a container can't read a ZFS pool's total, so you set it once
  (`zfs list -Hp -o name,used,avail -d 0`, size = used + avail).
- **Network:** download / upload speed over the physical network cards. Pick cards with `stats.network: [eno1]`.
- **Memory** "used" leaves out the ZFS cache (ARC), which is shown separately.
- Stats are measured every `statsIntervalSeconds` (default 5 s).

```yaml
stats:
  name: NAS                             # caption of the hub's own tiles
  network: [eno1]                       # optional
  disks:
    - { name: tank, path: /pools/tank, size: 3.6T }
```

## Stats from other machines

To add another machine (a Raspberry Pi, a second server, a VPS), run the same image there in **agent mode**. An agent
has no page and no config; it only answers the hub with that machine's numbers, and with its Docker containers.

**On the other machine:** save [compose.agent.yaml](../compose.agent.yaml) as `compose.yaml` and run
`docker compose up -d` (or without Docker: `HUB_MODE=agent PORT=8081 node src/server.js`).

**On the hub:** gear menu → Edit services and settings → *Machines*. Agents on the same network show up there by
themselves under **Found on the network**: click **Add** (and type the token, if the agent has one). Otherwise
*Other machines* → **Add machine**, or in the YAML:

```yaml
stats:
  machines:
    - name: Raspberry Pi
      url: http://{pi}:8081             # the agent's address; {host} shortcuts work
      token: a-long-random-text         # only if the agent has AGENT_TOKEN set
      network: [eth0]                   # optional: cards for the network tile
      disks:                            # optional: storage tiles, paths as the AGENT sees them
        - { name: SD card, path: /pools/root, size: 29G }
```

Each machine gets its own row of tiles under its name. One that does not answer shows why (refused, timed out, wrong
token) and never holds up the others. The hub asks every `statsIntervalSeconds`.

| Agent variable | Meaning |
|---|---|
| `HUB_MODE=agent` | Start as an agent instead of as the hub |
| `AGENT_TOKEN` | Optional shared secret. Without it, anyone who can reach the port can read the numbers |
| `DOCKER_HOST` | That machine's Docker (a read-only socket proxy, as in compose.agent.yaml): its containers are reported too |
| `AGENT_NAME` | The name the hub suggests when it finds this agent (default: the container's host name) |
| `PORT`, `PROC_PATH`, `SYS_PATH` | As for the hub |

## Containers on other machines

An agent with `DOCKER_HOST` sends its containers along with its numbers. The hub treats them like its own:
`containers:` patterns and *Container health badges* match them (the badge's tooltip names the machine), cards from
[Docker labels](configuration.md#cards-from-docker-labels) on that machine appear, and *Found on this server* also
lists that machine's containers, with its address filled in. When an agent stops answering, its containers count for
five more minutes, then the cards say "no container found".

## Finding agents on the network

The hub searches its home network for agents at start and every 10 minutes (or with *Search again* in the editor):
it asks every address of the networks the server sits in on ports 8081 and 8080 for `/healthz`, and keeps the ones
that answer as an agent. The networks come from the server's routing table (the `/proc` mount); Docker's own
networks, VPNs and networks larger than /22 are left out. Nothing is added by itself.

```yaml
settings:
  discovery:
    enabled: true                 # false = never search
    subnets: [192.168.1.0/24]     # instead of the networks found on the server
    ports: [8081]                 # where your agents answer
```

`AGENT_DISCOVERY: "off"` in the hub's compose file switches the search off completely. An agent's `/healthz` answers
without a token (name, version, whether it has Docker and a token): that is what the search looks for.

## What an agent shares

The agent only reports numbers, free space of the paths the hub asks for, and (with `DOCKER_HOST`) the list of its
containers: names, images, state and published ports, never their environment or files. The token is stored in the
hub's YAML, so everyone who may open the config editor can read it. Agent addresses and tokens are never sent to the
page. Use the token, and HTTPS or a VPN, when the agent is reachable from outside your network.
