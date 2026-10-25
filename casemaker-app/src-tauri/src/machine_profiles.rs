// #660 — THE PROFILE'S PORTS, AND THE KNOWN-MACHINE RULE, in one place on the Rust side.
//
// WHY THIS EXISTS. The embedded server opens sockets on a page's behalf: the #571 bridge
// (`/api/v1/machine/*`) dials a controller and moves bytes, and the #530 camera proxy dials the
// machine's camera module. Before this, both took a host and port from the REQUEST. With
// `casemaker --bind-all` on a LAN address that made the server a relay: any client on the LAN could
// have it open a socket to any address it could reach — the Z1's own command port included — and
// read and write through it. `guard.rs` does not stop that: it judges the PAGE (Host and Origin),
// which is the right rule for a browser, and is not a claim about where the socket goes.
//
// WHAT THIS ADDS. Two facts the request cannot supply, checked together before anything is dialled:
//
//   * the house's own location (`location.json`) is the list of machines that exist, at the
//     addresses they were recorded at; and
//   * a machine profile names the ports its own services listen on (`engine/cnc/machine.ts` on the
//     client side; {@link MachinePorts} here).
//
// A request is honoured only when its host is a machine record's address AND its port is one that
// machine's profile serves. Anything else — an address the house does not know, a port no profile
// serves, a record whose profile this build cannot name — is refused before a socket is opened.
//
// WHAT IT IS NOT. Not authentication, and not a claim that a LAN client is trusted: a client with no
// `Origin` still passes the provenance guard (guard.rs says why that is deliberate), and the app has
// no user model. What is closed here is the RELAY property — the server can only be made to talk to
// the machines in its own document, on their own ports. The full threat model is
// `docs/design/machine-bridge-threat-model.md`.

use crate::house::HouseStore;
use crate::location::MachineRecord;
use std::sync::Arc;

/// The ports one machine profile's own services listen on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MachinePorts {
    /// The controller's command channel (`COMMAND_TCP_PORT` in `platform/desktop/protocol.ts`).
    pub command: u16,
    /// The camera module's WebSocket, when the profile has a camera at all.
    pub camera: Option<u16>,
    /// The UDP port the machine broadcasts its discovery datagram on.
    pub discovery: u16,
}

/// Every profile this build knows, with its ports. The Rust-side copy of the numbers
/// `engine/cnc/machine.ts` and `platform/desktop/protocol.ts` hold for the client: a profile that is
/// added there without a row here fails CLOSED — its machine records are refused rather than offered
/// the Z1's ports.
const PROFILES: &[(&str, MachinePorts)] = &[(
    "Z1",
    MachinePorts {
        command: 2222,
        camera: Some(82),
        discovery: 3333,
    },
)];

/// The row for a profile id, or `None` for a profile this build does not know.
pub fn ports_for(profile_id: &str) -> Option<MachinePorts> {
    PROFILES
        .iter()
        .find(|(id, _)| *id == profile_id)
        .map(|(_, ports)| *ports)
}

/// How a route learns a profile's ports. Production is {@link ports_for}; a test injects a stand-in
/// listener's ephemeral port, which no profile could ever name.
pub type PortsOf = Arc<dyn Fn(&str) -> Option<MachinePorts> + Send + Sync>;

/// The table production uses.
pub fn standard_ports() -> PortsOf {
    Arc::new(ports_for)
}

/// Does this profile serve `port` — command, camera or discovery?
pub fn serves(ports: MachinePorts, port: u16) -> bool {
    ports.command == port || ports.camera == Some(port) || ports.discovery == port
}

/// Is `port` the DISCOVERY port of some profile this build knows? The UDP listen has no host to pick
/// a profile by, and its only use is discovery (`DISCOVERY_UDP_PORT` in `protocol.ts`), so its rule
/// is the narrower half of the port table rather than the whole of it: a local bind is still bounded
/// by a list the request cannot extend.
pub fn any_profile_discovers(ports: &dyn Fn(&str) -> Option<MachinePorts>, port: u16) -> bool {
    PROFILES
        .iter()
        .filter_map(|(id, _)| ports(id))
        .any(|p| p.discovery == port)
}

/// The location's machine records, or the sentence that says why no machine can be known — a
/// location that cannot be read knows no machines, and a route that opens sockets does not guess.
pub async fn machines_in(house: &HouseStore) -> Result<Vec<MachineRecord>, String> {
    // `machines()` clones the records and nothing else: this runs on every connect, and the whole
    // location document is what `location()` builds for the endpoint that serves it.
    house
        .machines()
        .await
        .map_err(|e| format!("the location cannot be read, so no machine is known: {e}"))
}

/// THE KNOWN-MACHINE REFUSAL for a TCP target. `None` means "this is a machine of ours, on a port
/// its profile serves"; `Some(sentence)` is the refusal to send, naming which of the three things
/// failed — the address, the profile, or the port.
///
/// Kept over the machine list rather than the store so the rule is a pure function with its own
/// tests; the caller reads the location once.
pub fn target_refusal(
    machines: &[MachineRecord],
    ports: &dyn Fn(&str) -> Option<MachinePorts>,
    host: &str,
    port: u16,
) -> Option<String> {
    let mut host_known = false;
    let mut profile_known = false;
    for machine in machines {
        let Some(address) = &machine.address else {
            continue;
        };
        if address.host != host {
            continue;
        }
        host_known = true;
        let Some(profile_ports) = machine.profile_id.as_deref().and_then(|id| ports(id)) else {
            continue;
        };
        profile_known = true;
        if serves(profile_ports, port) {
            return None;
        }
    }
    if !host_known {
        Some(format!("`{host}` is not a machine this house knows."))
    } else if !profile_known {
        Some(format!(
            "`{host}` is a machine this house knows, but its profile is not one this build knows."
        ))
    } else {
        Some(format!(
            "`{host}` is a machine this house knows, but its profile does not serve port {port}."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(host: &str, profile: Option<&str>) -> MachineRecord {
        let mut record: MachineRecord = serde_json::from_value(serde_json::json!({
            "id": format!("m-{host}"),
            "address": { "host": host, "port": 2222 },
            "updatedAt": "2026-10-25T00:00:00.000Z"
        }))
        .unwrap();
        record.profile_id = profile.map(str::to_string);
        record
    }

    #[test]
    fn a_known_machine_on_a_port_its_profile_serves_passes() {
        let machines = [machine("192.0.2.10", Some("Z1"))];
        for port in [2222, 82, 3333] {
            assert_eq!(
                target_refusal(&machines, &ports_for, "192.0.2.10", port),
                None,
                "the Z1 serves {port}"
            );
        }
    }

    #[test]
    fn the_three_ways_a_target_can_fail_are_named_apart() {
        let machines = [
            machine("192.0.2.10", Some("Z1")),
            machine("192.0.2.12", Some("OTHER")),
        ];
        // An address the house does not have at all.
        let unknown_host = target_refusal(&machines, &ports_for, "192.0.2.11", 2222).unwrap();
        assert!(unknown_host.contains("not a machine this house knows"), "{unknown_host}");
        // A machine it does have, on a port no profile serves.
        let wrong_port = target_refusal(&machines, &ports_for, "192.0.2.10", 9999).unwrap();
        assert!(wrong_port.contains("does not serve port 9999"), "{wrong_port}");
        // A machine whose profile this build cannot name: no ports it can vouch for.
        let unknown_profile = target_refusal(&machines, &ports_for, "192.0.2.12", 2222).unwrap();
        assert!(unknown_profile.contains("profile is not one this build knows"), "{unknown_profile}");
        // A record with NO profile is the same answer as one naming a profile we do not know.
        let none = [machine("192.0.2.13", None)];
        assert!(target_refusal(&none, &ports_for, "192.0.2.13", 2222)
            .unwrap()
            .contains("profile is not one this build knows"));
    }

    #[test]
    fn a_record_without_an_address_names_no_target() {
        let mut bare = machine("192.0.2.10", Some("Z1"));
        bare.address = None;
        assert!(target_refusal(&[bare], &ports_for, "192.0.2.10", 2222)
            .unwrap()
            .contains("not a machine this house knows"));
    }

    #[test]
    fn the_discovery_listen_takes_only_a_profiles_discovery_port() {
        assert!(any_profile_discovers(&ports_for, 3333));
        // Discovery is all the UDP listen is for: the command and camera ports are not binds it
        // offers, even though a machine's profile serves them over TCP.
        assert!(!any_profile_discovers(&ports_for, 2222));
        assert!(!any_profile_discovers(&ports_for, 82));
        assert!(!any_profile_discovers(&ports_for, 8080));
    }
}
