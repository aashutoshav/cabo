import { useCallback, useEffect, useState } from "react";
import { normalizeRoomKey } from "../worker/protocol";
import { Rules } from "./Rules";
import { Table } from "./Table";
import { loadName, saveName, useRoom } from "./useRoom";

function roomFromUrl(): string | null {
  const raw = new URLSearchParams(location.search).get("room");
  if (!raw) return null;
  const key = normalizeRoomKey(raw);
  return key.length >= 4 ? key : null;
}

/** Room keys are stored bare but shown hyphenated: PLUM4213 -> PLUM-4213 */
export function prettyKey(key: string): string {
  const m = /^([A-Z]+)(\d+)$/.exec(key);
  return m ? `${m[1]}-${m[2]}` : key;
}

export function App() {
  const [roomKey, setRoomKey] = useState<string | null>(roomFromUrl);
  const [name, setName] = useState(loadName);
  const [joined, setJoined] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const room = useRoom(joined ? roomKey : null, name);

  useEffect(() => {
    if (roomKey) {
      const url = new URL(location.href);
      url.searchParams.set("room", prettyKey(roomKey));
      history.replaceState(null, "", url);
    }
  }, [roomKey]);

  const leave = useCallback(() => {
    setJoined(false);
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
    setRoomKey(null);
  }, []);

  if (!joined || !roomKey) {
    return (
      <>
        <Landing
          name={name}
          setName={setName}
          roomKey={roomKey}
          setRoomKey={setRoomKey}
          onJoin={() => {
            saveName(name.trim() || "Player");
            setJoined(true);
          }}
          onShowRules={() => setShowRules(true)}
        />
        {showRules && <Rules onClose={() => setShowRules(false)} />}
      </>
    );
  }

  return (
    <>
      <Table room={room} roomKey={roomKey} onLeave={leave} onShowRules={() => setShowRules(true)} />
      {showRules && <Rules onClose={() => setShowRules(false)} />}
    </>
  );
}

interface LandingProps {
  name: string;
  setName: (n: string) => void;
  roomKey: string | null;
  setRoomKey: (k: string | null) => void;
  onJoin: () => void;
  onShowRules: () => void;
}

function Landing({ name, setName, roomKey, setRoomKey, onJoin, onShowRules }: LandingProps) {
  const [keyInput, setKeyInput] = useState(roomKey ? prettyKey(roomKey) : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const createRoom = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/new-room");
      if (!res.ok) throw new Error("Could not reach the server.");
      const data = (await res.json()) as { roomKey: string };
      setRoomKey(normalizeRoomKey(data.roomKey));
      onJoin();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const joinRoom = () => {
    const key = normalizeRoomKey(keyInput);
    if (key.length < 4) {
      setProblem("That room key looks too short.");
      return;
    }
    setRoomKey(key);
    onJoin();
  };

  return (
    <div className="landing">
      <div className="landing-card">
        <h1 className="brand">
          Cabo<span className="brand-dot">.</span>
        </h1>
        <p className="tagline">Lowest hand wins. Snap fast. Call it before they do.</p>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Aashutosh"
            maxLength={16}
            onKeyDown={(e) => e.key === "Enter" && keyInput && joinRoom()}
          />
        </label>

        <button className="btn btn-primary btn-lg" onClick={createRoom} disabled={busy}>
          {busy ? "Creating..." : "Create a room"}
        </button>

        <div className="divider"><span>or join with a key</span></div>

        <div className="join-row">
          <input
            className="key-input"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value.toUpperCase())}
            placeholder="PLUM-4213"
            maxLength={12}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
          />
          <button className="btn" onClick={joinRoom} disabled={busy}>Join</button>
        </div>

        {problem && <p className="problem">{problem}</p>}

        <button className="link-btn" onClick={onShowRules}>Read the house rules</button>
      </div>
    </div>
  );
}
