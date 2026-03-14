"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function formatDateLabel(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type PoolDate = {
  id: string;
  label: string;
  date: string;
};

type PlayerRow = {
  id: number;
  name: string;
  email: string;
  skill: number;
  waiver_signed: boolean;
  status: string;
  created_at?: string;
};

type AvailabilityRow = {
  player_id: number;
  date_code: string;
};

type PlayerWithAvailability = {
  id: number;
  name: string;
  email: string;
  skill: number;
  waiverSigned: boolean;
  status: string;
  availability: string[];
};
function addMinutes(timeString: string, minutesToAdd: number) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const nextHours = Math.floor(totalMinutes / 60) % 24;
  const nextMinutes = totalMinutes % 60;
  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

function chunkIntoPools(players: PlayerWithAvailability[]) {
  const approved = players.filter((p) => p.status === "approved");
  const sorted = [...approved].sort((a, b) => {
    return b.skill - a.skill || a.name.localeCompare(b.name);
  });

  const poolA: PlayerWithAvailability[] = [];
  const poolB: PlayerWithAvailability[] = [];
  let poolASkill = 0;
  let poolBSkill = 0;

  sorted.forEach((player, index) => {
    const shouldGoToA =
      poolA.length < Math.ceil(sorted.length / 2) &&
      (poolB.length >= Math.floor(sorted.length / 2) || poolASkill <= poolBSkill || index % 2 === 0);

    if (shouldGoToA) {
      poolA.push(player);
      poolASkill += player.skill;
    } else {
      poolB.push(player);
      poolBSkill += player.skill;
    }
  });

  return { A: poolA, B: poolB };
}

function getPlayerAvailabilityMap(players: PlayerWithAvailability[]) {
  return Object.fromEntries(players.map((player) => [player.name, player.availability || []]));
}

function scoreMatchForSlot(
  match: any,
  slot: any,
  scheduledCounts: Record<string, number>,
  availabilityMap: Record<string, string[]>
) {
  const p1Avail = availabilityMap[match.p1] || [];
  const p2Avail = availabilityMap[match.p2] || [];
  const bothAvailable = p1Avail.includes(slot.dateId) && p2Avail.includes(slot.dateId);
  const balancePenalty = (scheduledCounts[match.p1] || 0) + (scheduledCounts[match.p2] || 0);
  return (bothAvailable ? 100 : 0) - balancePenalty;
}

function buildPoolSlots(courtCount = 2, weekdayStart = "18:00", poolDates: PoolDate[]) {
  const times = [
    weekdayStart,
    addMinutes(weekdayStart, 40),
    addMinutes(weekdayStart, 80),
  ];

  return poolDates.flatMap((day) =>
    times.map((time, index) => ({
      id: `${day.id}-${index + 1}`,
      dateId: day.id,
      dayLabel: `${day.label} • ${formatDateLabel(day.date)}`,
      startTime: time,
      endTime: addMinutes(time, 30),
      courtCount,
    }))
  );
}

function assignMatchesToAvailabilitySlots(
  rawMatches: any[],
  playersInPool: PlayerWithAvailability[],
  courtCount = 2,
  weekdayStart = "18:00",
  poolDates: PoolDate[]
) {
  const availabilityMap = getPlayerAvailabilityMap(playersInPool);
  const slots = buildPoolSlots(courtCount, weekdayStart, poolDates);
  const scheduledCounts = Object.fromEntries(playersInPool.map((p) => [p.name, 0]));
  const unassigned = rawMatches.map((m) => ({ ...m }));
  const scheduled: any[] = [];

  slots.forEach((slot) => {
    const usedPlayers = new Set<string>();

    for (let court = 1; court <= courtCount; court += 1) {
      const eligible = unassigned.filter(
        (m) => !m.assigned && !usedPlayers.has(m.p1) && !usedPlayers.has(m.p2)
      );
      if (!eligible.length) break;

      eligible.sort(
        (a, b) =>
          scoreMatchForSlot(b, slot, scheduledCounts, availabilityMap) -
          scoreMatchForSlot(a, slot, scheduledCounts, availabilityMap)
      );

      const chosen = eligible[0];
      chosen.assigned = true;
      usedPlayers.add(chosen.p1);
      usedPlayers.add(chosen.p2);
      scheduledCounts[chosen.p1] += 1;
      scheduledCounts[chosen.p2] += 1;

      const p1Avail = availabilityMap[chosen.p1] || [];
      const p2Avail = availabilityMap[chosen.p2] || [];

      scheduled.push({
        ...chosen,
        court,
        slotDateId: slot.dateId,
        dayLabel: slot.dayLabel,
        startTime: slot.startTime,
        endTime: slot.endTime,
        preferredSlot: p1Avail.includes(slot.dateId) && p2Avail.includes(slot.dateId),
      });
    }
  });

  const leftovers = unassigned.filter((m) => !m.assigned);
  leftovers.forEach((match, index) => {
    const slot = slots[index % slots.length];
    scheduled.push({
      ...match,
      court: (index % courtCount) + 1,
      slotDateId: slot.dateId,
      dayLabel: `${slot.dayLabel} • Fallback`,
      startTime: slot.startTime,
      endTime: slot.endTime,
      preferredSlot: false,
    });
  });

  return scheduled.sort((a, b) => {
    if ((a.slotDateId || "") !== (b.slotDateId || "")) return (a.slotDateId || "").localeCompare(b.slotDateId || "");
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.court - b.court;
  });
}

function generateRoundRobinMatches(
  playersInPool: PlayerWithAvailability[],
  poolLabel: string,
  courtCount = 2,
  weekdayStart = "18:00",
  poolDates: PoolDate[]
) {
  const matches: any[] = [];

  for (let i = 0; i < playersInPool.length; i += 1) {
    for (let j = i + 1; j < playersInPool.length; j += 1) {
      matches.push({
        pool: poolLabel,
        stage: "pool",
        round: 1,
        p1: playersInPool[i].name,
        p2: playersInPool[j].name,
        s1: null,
        s2: null,
        status: "upcoming",
        format: "1 game to 11",
      });
    }
  }

  return assignMatchesToAvailabilitySlots(matches, playersInPool, courtCount, weekdayStart, poolDates).map(
    (m, index) => ({
      ...m,
      round: index + 1,
    })
  );
}

function generatePlayoffMatches(standings: any, saturdayStart = "09:00", courtCount = 2) {
  const a1 = standings.A[0]?.player || "Pool A #1";
  const a2 = standings.A[1]?.player || "Pool A #2";
  const b1 = standings.B[0]?.player || "Pool B #1";
  const b2 = standings.B[1]?.player || "Pool B #2";

  const semi1Start = saturdayStart;
  const semi2Start = courtCount > 1 ? saturdayStart : addMinutes(saturdayStart, 60);
  const finalStart = courtCount > 1 ? addMinutes(saturdayStart, 60) : addMinutes(semi2Start, 60);

  return [
    {
      pool: "Playoff",
      stage: "semifinal",
      round: 1,
      court: 1,
      p1: a1,
      p2: b2,
      s1: null,
      s2: null,
      status: "upcoming",
      dayLabel: "Saturday Bracket Play",
      slotDateCode: "playoff",
      startTime: semi1Start,
      endTime: addMinutes(semi1Start, 50),
      preferredSlot: true,
      format: "Best 2 of 3 to 11",
    },
    {
      pool: "Playoff",
      stage: "semifinal",
      round: 1,
      court: courtCount > 1 ? 2 : 1,
      p1: b1,
      p2: a2,
      s1: null,
      s2: null,
      status: "upcoming",
      dayLabel: "Saturday Bracket Play",
      slotDateCode: "playoff",
      startTime: semi2Start,
      endTime: addMinutes(semi2Start, 50),
      preferredSlot: true,
      format: "Best 2 of 3 to 11",
    },
    {
      pool: "Playoff",
      stage: "final",
      round: 2,
      court: 1,
      p1: "Winner Semi 1",
      p2: "Winner Semi 2",
      s1: null,
      s2: null,
      status: "upcoming",
      dayLabel: "Saturday Bracket Play",
      slotDateCode: "playoff",
      startTime: finalStart,
      endTime: addMinutes(finalStart, 50),
      preferredSlot: true,
      format: "Best 2 of 3 to 11",
    },
  ];
}

function computeStandings(matches: any[], playerNames: string[]) {
  const stats = Object.fromEntries(
    playerNames.map((name) => [
      name,
      { player: name, played: 0, wins: 0, losses: 0, pf: 0, pa: 0, diff: 0 },
    ])
  );

  matches.forEach((m) => {
    const s1 = Number(m.s1);
    const s2 = Number(m.s2);
    if (!playerNames.includes(m.p1) || !playerNames.includes(m.p2)) return;
    if (!Number.isFinite(s1) || !Number.isFinite(s2)) return;

    stats[m.p1].played += 1;
    stats[m.p2].played += 1;
    stats[m.p1].pf += s1;
    stats[m.p1].pa += s2;
    stats[m.p2].pf += s2;
    stats[m.p2].pa += s1;

    if (s1 > s2) {
      stats[m.p1].wins += 1;
      stats[m.p2].losses += 1;
    } else if (s2 > s1) {
      stats[m.p2].wins += 1;
      stats[m.p1].losses += 1;
    }
  });

  return Object.values(stats)
    .map((r: any) => ({ ...r, diff: r.pf - r.pa }))
    .sort((a: any, b: any) => b.wins - a.wins || b.diff - a.diff || b.pf - a.pf || a.player.localeCompare(b.player));
}

function standingsByPool(matches: any[], players: PlayerWithAvailability[]) {
  const pools = chunkIntoPools(players);
  const poolOnly = matches.filter((m) => m.stage === "pool");
  return {
    A: computeStandings(poolOnly.filter((m) => m.pool === "A"), pools.A.map((p) => p.name)),
    B: computeStandings(poolOnly.filter((m) => m.pool === "B"), pools.B.map((p) => p.name)),
  };
}
export default function AdminPage() {
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  
  const [courtCount, setCourtCount] = useState(2);
  const [weekdayStart, setWeekdayStart] = useState("18:00");
  const [saturdayStart, setSaturdayStart] = useState("09:00");
  const [players, setPlayers] = useState<PlayerWithAvailability[]>([]);
  const [poolDates, setPoolDates] = useState<PoolDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const pendingPlayers = useMemo(
    () => players.filter((p) => p.status === "pending"),
    [players]
  );

  const approvedPlayers = useMemo(
    () => players.filter((p) => p.status === "approved"),
    [players]
  );

function checkPassword() {
  if (passwordInput === "mocha") {
    setAdminAuthenticated(true);
  } else {
    alert("Incorrect password");
  }
}

async function loadAdminData() {
    setLoading(true);

const [
  { data: playerRows, error: playerError },
  { data: availabilityRows, error: availabilityError },
  { data: poolDateRows, error: poolDateError },
  { data: settingsRow, error: settingsError },
] = await Promise.all([
  supabase.from("players").select("*").order("created_at", { ascending: true }),
  supabase.from("player_availability").select("*"),
  supabase.from("pool_dates").select("*").order("event_date", { ascending: true }),
  supabase.from("tournament_settings").select("*").limit(1).maybeSingle(),
]);
    if (playerError) {
      setMessage(`Could not load players: ${playerError.message}`);
      setLoading(false);
      return;
    }

    if (availabilityError) {
      setMessage(`Could not load availability: ${availabilityError.message}`);
      setLoading(false);
      return;
    }

    if (poolDateError) {
      setMessage(`Could not load pool dates: ${poolDateError.message}`);
      setLoading(false);
      return;
    }
if (settingsError) {
  setMessage(`Could not load settings: ${settingsError.message}`);
  setLoading(false);
  return;
}

if (settingsRow) {
  setCourtCount(Number(settingsRow.court_count || 2));
  setWeekdayStart(settingsRow.weekday_start || "18:00");
  setSaturdayStart(settingsRow.saturday_start || "09:00");
}
    const mappedPoolDates: PoolDate[] = (poolDateRows || []).map((row: any) => ({
      id: row.code,
      label: row.label,
      date: row.event_date,
    }));

    const availabilityMap = new Map<number, string[]>();
    (availabilityRows as AvailabilityRow[] | null | undefined || []).forEach((row) => {
      const current = availabilityMap.get(row.player_id) || [];
      current.push(row.date_code);
      availabilityMap.set(row.player_id, current);
    });

    const mergedPlayers: PlayerWithAvailability[] = (playerRows as PlayerRow[] | null | undefined || []).map((player) => ({
      id: player.id,
      name: player.name,
      email: player.email,
      skill: Number(player.skill),
      waiverSigned: player.waiver_signed,
      status: player.status,
      availability: availabilityMap.get(player.id) || [],
    }));

    setPoolDates(mappedPoolDates);
    setPlayers(mergedPlayers);
    setLoading(false);
  }


  useEffect(() => {
    loadAdminData();
  }, []);

async function approvePlayer(playerId: number) {
  setWorkingId(playerId);
  setMessage("");

  const { data, error } = await supabase
    .from("players")
    .update({ status: "approved" })
    .eq("id", playerId)
    .select();

  if (error) {
    setMessage(`Approve error: ${error.message}`);
    setWorkingId(null);
    return;
  }

  setMessage(`Approved rows: ${data?.length ?? 0}`);
  await loadAdminData();
  setWorkingId(null);
}

  async function removePlayer(playerId: number) {
    setWorkingId(playerId);
    setMessage("");

    const { error } = await supabase
      .from("players")
      .delete()
      .eq("id", playerId);

    if (error) {
      setMessage(`Delete error: ${error.message}`);
      setWorkingId(null);
      return;
    }

    await loadAdminData();
    setWorkingId(null);
    setMessage("Player removed.");
  }
async function generateSchedule() {
  setMessage("Generating schedule...");

  const approved = players.filter((p) => p.status === "approved");
  if (approved.length < 4) {
    setMessage("You need at least 4 approved players to generate a schedule.");
    return;
  }

  const pools = chunkIntoPools(approved);
  const matchesA = generateRoundRobinMatches(pools.A, "A", courtCount, weekdayStart, poolDates);
  const matchesB = generateRoundRobinMatches(pools.B, "B", courtCount, weekdayStart, poolDates);

  const poolMatches = [...matchesA, ...matchesB];

  const standings = standingsByPool(poolMatches, approved);
  const playoffMatches = generatePlayoffMatches(standings, saturdayStart, courtCount);

  const allMatches = [...poolMatches, ...playoffMatches].map((m, index) => ({
    pool: m.pool,
    stage: m.stage,
    round: m.round ?? index + 1,
    court: m.court,
    p1: m.p1,
    p2: m.p2,
    s1: m.s1,
    s2: m.s2,
    status: m.status,
    day_label: m.dayLabel,
    slot_date_code: m.slotDateId || m.slotDateCode || null,
    start_time: m.startTime,
    end_time: m.endTime,
    preferred_slot: m.preferredSlot ?? false,
    format: m.format,
  }));

  const { error: deleteError } = await supabase
    .from("matches")
    .delete()
    .neq("id", 0);

  if (deleteError) {
    setMessage(`Could not clear old matches: ${deleteError.message}`);
    return;
  }

  const { error: insertError } = await supabase
    .from("matches")
    .insert(allMatches);

  if (insertError) {
    setMessage(`Could not save matches: ${insertError.message}`);
    return;
  }

  setMessage(`Schedule generated: ${allMatches.length} matches saved.`);
}
  function renderAvailability(dateIds: string[]) {
    const labels = dateIds
      .map((id) => poolDates.find((d) => d.id === id))
      .filter(Boolean)
      .map((d) => `${d!.label} (${formatDateLabel(d!.date)})`);

    return labels.length ? labels.join(", ") : "None";
  }
  if (!adminAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="bg-white p-8 rounded-2xl shadow w-80 space-y-4">
          <h2 className="text-xl font-semibold">Admin Login</h2>
          <input
            type="password"
            placeholder="Enter admin password"
            className="w-full border rounded px-3 py-2"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
          />
          <button
            className="w-full bg-black text-white rounded py-2"
            onClick={checkPassword}
          >
            Enter
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Tournament Admin</CardTitle>
            <CardDescription>
              Review registrations and approve players.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3 text-sm">
  <Badge variant="secondary">Pending: {pendingPlayers.length}</Badge>
  <Badge>Approved: {approvedPlayers.length}</Badge>
</div>
{message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
<div>
  <Button onClick={generateSchedule}>Generate Schedule</Button>
</div>
{loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
          </CardContent>
        </Card>

        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle>Pending Players</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!pendingPlayers.length && !loading ? (
              <p className="text-sm text-muted-foreground">No pending players.</p>
            ) : null}

            {pendingPlayers.map((player) => (
              <div
                key={player.id}
                className="rounded-2xl border bg-white p-4 shadow-sm"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <div className="text-lg font-semibold">{player.name}</div>
                    <div className="text-sm text-muted-foreground">{player.email}</div>
                    <div className="text-sm text-muted-foreground">
                      Skill: {player.skill}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Waiver: {player.waiverSigned ? "Signed" : "Missing"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Availability: {renderAvailability(player.availability)}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={() => approvePlayer(player.id)}
                      disabled={workingId === player.id}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => removePlayer(player.id)}
                      disabled={workingId === player.id}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle>Approved Players</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!approvedPlayers.length && !loading ? (
              <p className="text-sm text-muted-foreground">No approved players yet.</p>
            ) : null}

            {approvedPlayers.map((player) => (
              <div
                key={player.id}
                className="rounded-2xl border bg-white p-4 shadow-sm"
              >
                <div className="space-y-1">
                  <div className="text-lg font-semibold">{player.name}</div>
                  <div className="text-sm text-muted-foreground">{player.email}</div>
                  <div className="text-sm text-muted-foreground">
                    Skill: {player.skill}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Availability: {renderAvailability(player.availability)}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}