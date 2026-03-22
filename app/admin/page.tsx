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

function addMinutes(timeString: string, minutesToAdd: number) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const nextHours = Math.floor(totalMinutes / 60) % 24;
  const nextMinutes = totalMinutes % 60;
  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

type Announcement = {
  id: number;
  title: string;
  body: string;
  priority: "info" | "warning" | "important";
  created_at: string;
};

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
  duprId?: string;
};

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
  const lastSlotIndex = Object.fromEntries(playersInPool.map((p) => [p.name, -99]));

  const unassigned = rawMatches.map((m) => ({ ...m }));
  const scheduled: any[] = [];

  slots.forEach((slot, slotIndex) => {
    const usedPlayers = new Set<string>();

    for (let court = 1; court <= courtCount; court += 1) {
      const eligible = unassigned.filter((m) => {
        if (m.assigned) return false;
        if (usedPlayers.has(m.p1) || usedPlayers.has(m.p2)) return false;

        const p1Avail = availabilityMap[m.p1] || [];
        const p2Avail = availabilityMap[m.p2] || [];

        const p1Available = p1Avail.includes(slot.dateId);
        const p2Available = p2Avail.includes(slot.dateId);

        return p1Available && p2Available;
      });

      if (!eligible.length) break;

      eligible.sort((a, b) => {
        const aPenalty =
          (scheduledCounts[a.p1] || 0) +
          (scheduledCounts[a.p2] || 0) +
          (slotIndex - (lastSlotIndex[a.p1] ?? -99) <= 1 ? 5 : 0) +
          (slotIndex - (lastSlotIndex[a.p2] ?? -99) <= 1 ? 5 : 0);

        const bPenalty =
          (scheduledCounts[b.p1] || 0) +
          (scheduledCounts[b.p2] || 0) +
          (slotIndex - (lastSlotIndex[b.p1] ?? -99) <= 1 ? 5 : 0) +
          (slotIndex - (lastSlotIndex[b.p2] ?? -99) <= 1 ? 5 : 0);

        return aPenalty - bPenalty;
      });

      const chosen = eligible[0];
      chosen.assigned = true;

      usedPlayers.add(chosen.p1);
      usedPlayers.add(chosen.p2);

      scheduledCounts[chosen.p1] += 1;
      scheduledCounts[chosen.p2] += 1;

      lastSlotIndex[chosen.p1] = slotIndex;
      lastSlotIndex[chosen.p2] = slotIndex;

      scheduled.push({
        ...chosen,
        court,
        slotDateId: slot.dateId,
        dayLabel: `${slot.dayLabel}`,
        startTime: slot.startTime,
        endTime: slot.endTime,
        preferredSlot: true,
      });
    }
  });

  // Fallback pass 1: allow at least one player available
  slots.forEach((slot, slotIndex) => {
    const usedPlayers = new Set(
      scheduled
        .filter((m) => m.slotDateId === slot.dateId && m.startTime === slot.startTime)
        .flatMap((m) => [m.p1, m.p2])
    );

    const courtsUsed = scheduled.filter(
      (m) => m.slotDateId === slot.dateId && m.startTime === slot.startTime
    ).length;

    for (let court = courtsUsed + 1; court <= courtCount; court += 1) {
      const eligible = unassigned.filter((m) => {
        if (m.assigned) return false;
        if (usedPlayers.has(m.p1) || usedPlayers.has(m.p2)) return false;

        const p1Avail = availabilityMap[m.p1] || [];
        const p2Avail = availabilityMap[m.p2] || [];

        const p1Available = p1Avail.includes(slot.dateId);
        const p2Available = p2Avail.includes(slot.dateId);

        return p1Available || p2Available;
      });

      if (!eligible.length) break;

      eligible.sort((a, b) => {
        const aPenalty =
          (scheduledCounts[a.p1] || 0) +
          (scheduledCounts[a.p2] || 0) +
          (slotIndex - (lastSlotIndex[a.p1] ?? -99) <= 1 ? 5 : 0) +
          (slotIndex - (lastSlotIndex[a.p2] ?? -99) <= 1 ? 5 : 0);

        const bPenalty =
          (scheduledCounts[b.p1] || 0) +
          (scheduledCounts[b.p2] || 0) +
          (slotIndex - (lastSlotIndex[b.p1] ?? -99) <= 1 ? 5 : 0) +
          (slotIndex - (lastSlotIndex[b.p2] ?? -99) <= 1 ? 5 : 0);

        return aPenalty - bPenalty;
      });

      const chosen = eligible[0];
      chosen.assigned = true;

      usedPlayers.add(chosen.p1);
      usedPlayers.add(chosen.p2);

      scheduledCounts[chosen.p1] += 1;
      scheduledCounts[chosen.p2] += 1;

      lastSlotIndex[chosen.p1] = slotIndex;
      lastSlotIndex[chosen.p2] = slotIndex;

      scheduled.push({
        ...chosen,
        court,
        slotDateId: slot.dateId,
        dayLabel: `${slot.dayLabel} • Partial Availability`,
        startTime: slot.startTime,
        endTime: slot.endTime,
        preferredSlot: false,
      });
    }
  });

  // Fallback pass 2: force remaining matches anywhere
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
    if ((a.slotDateId || "") !== (b.slotDateId || "")) {
      return (a.slotDateId || "").localeCompare(b.slotDateId || "");
    }
    if (a.startTime !== b.startTime) {
      return a.startTime.localeCompare(b.startTime);
    }
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

  const rows = Object.values(stats).map((r: any) => ({ ...r, diff: r.pf - r.pa }));

  // Group players by wins so N-way ties are resolved as a group, not pairwise
  const winGroups = new Map<number, any[]>();
  rows.forEach((r) => {
    const group = winGroups.get(r.wins) || [];
    group.push(r);
    winGroups.set(r.wins, group);
  });

  const result: any[] = [];
  for (const wins of [...winGroups.keys()].sort((a, b) => b - a)) {
    const group = winGroups.get(wins)!;

    if (group.length === 1) {
      result.push(...group);
      continue;
    }

    // Compute mini-standings using only matches played among tied players
    const groupNames = group.map((r: any) => r.player);
    const groupMatches = matches.filter(
      (m) =>
        groupNames.includes(m.p1) &&
        groupNames.includes(m.p2) &&
        m.s1 !== "" && m.s2 !== ""
    );

    const mini = Object.fromEntries(groupNames.map((name) => [name, { wins: 0, diff: 0, pf: 0 }]));
    groupMatches.forEach((m: any) => {
      const s1 = Number(m.s1);
      const s2 = Number(m.s2);
      mini[m.p1].pf += s1;
      mini[m.p1].diff += s1 - s2;
      mini[m.p2].pf += s2;
      mini[m.p2].diff += s2 - s1;
      if (s1 > s2) mini[m.p1].wins += 1;
      else if (s2 > s1) mini[m.p2].wins += 1;
    });

    // Coin flip assigned once per group so it's stable within a single sort
    const coinFlip = Object.fromEntries(groupNames.map((name) => [name, Math.random()]));

    result.push(
      ...group.sort((a: any, b: any) => {
        const ma = mini[a.player];
        const mb = mini[b.player];
        if (mb.wins !== ma.wins) return mb.wins - ma.wins;    // h2h wins in group
        if (mb.diff !== ma.diff) return mb.diff - ma.diff;    // h2h point diff in group
        if (mb.pf !== ma.pf) return mb.pf - ma.pf;           // h2h points in group
        if (b.diff !== a.diff) return b.diff - a.diff;        // overall point diff
        if (b.pf !== a.pf) return b.pf - a.pf;               // overall points
        return coinFlip[a.player] - coinFlip[b.player];       // coin flip
      })
    );
  }

  return result;
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
  const [tournamentName, setTournamentName] = useState("");
  const [clubId, setClubId] = useState("");
  const [playoffDate, setPlayoffDate] = useState("");
  const [players, setPlayers] = useState<PlayerWithAvailability[]>([]);
  const [poolDates, setPoolDates] = useState<PoolDate[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [scheduleLocked, setScheduleLocked] = useState(false);
  const [showConfirmGenerate, setShowConfirmGenerate] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementForm, setAnnouncementForm] = useState({
    title: "",
    body: "",
    priority: "info" as Announcement["priority"],
  });

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
      { data: matchRows, error: matchError },
    ] = await Promise.all([
      supabase.from("players").select("*").order("created_at", { ascending: true }),
      supabase.from("player_availability").select("*"),
      supabase.from("pool_dates").select("*").order("event_date", { ascending: true }),
      supabase.from("tournament_settings").select("*").limit(1).maybeSingle(),
      supabase.from("matches").select("*").order("stage", { ascending: true }).order("round", { ascending: true }).order("start_time", { ascending: true }),
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

    if (matchError) {
      setMessage(`Could not load matches: ${matchError.message}`);
      setLoading(false);
      return;
    }

    if (settingsRow) {
      setCourtCount(Number(settingsRow.court_count || 2));
      setWeekdayStart(settingsRow.weekday_start || "18:00");
      setSaturdayStart(settingsRow.saturday_start || "09:00");
      setTournamentName(settingsRow.tournament_name || "");
      setScheduleLocked(!!settingsRow.schedule_locked);
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
      duprId: (player as any).dupr_id || "",
    }));

    const { data: announcementRows } = await supabase
      .from("announcements")
      .select("*")
      .order("created_at", { ascending: false });

    setAnnouncements((announcementRows as Announcement[]) || []);
    setPoolDates(mappedPoolDates);
    setPlayers(mergedPlayers);
    setMatches(matchRows || []);
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
function generateRawRoundRobinMatches(
  playersInPool: PlayerWithAvailability[],
  poolLabel: string
) {
  const matches: any[] = [];

  const skipPairs = new Set<string>();

  // For a 6-player pool, make it a modified round robin:
  // each player skips exactly one opponent.
  if (playersInPool.length === 6) {
    skipPairs.add([0, 5].join("-")); // seed 1 skips seed 6
    skipPairs.add([1, 4].join("-")); // seed 2 skips seed 5
    skipPairs.add([2, 3].join("-")); // seed 3 skips seed 4
  }

  for (let i = 0; i < playersInPool.length; i += 1) {
    for (let j = i + 1; j < playersInPool.length; j += 1) {
      if (skipPairs.has([i, j].join("-"))) {
        continue;
      }

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

  return matches;
}
  async function toggleScheduleLock() {
    const newValue = !scheduleLocked;
    const { error } = await supabase
      .from("tournament_settings")
      .update({ schedule_locked: newValue })
      .neq("id", 0);
    if (error) {
      setMessage(`Could not update lock: ${error.message}`);
      return;
    }
    setScheduleLocked(newValue);
    setMessage(newValue ? "Schedule locked." : "Schedule unlocked.");
  }

  async function generateSchedule() {
    setMessage("Generating schedule...");

    const approved = players.filter((p) => p.status === "approved");
    if (approved.length < 4) {
      setMessage("You need at least 4 approved players to generate a schedule.");
      return;
    }

const pools = chunkIntoPools(approved);

const rawMatchesA = generateRawRoundRobinMatches(pools.A, "A");
const rawMatchesB = generateRawRoundRobinMatches(pools.B, "B");

const combinedRawPoolMatches = [...rawMatchesA, ...rawMatchesB];

const poolMatches = assignMatchesToAvailabilitySlots(
  combinedRawPoolMatches,
  approved,
  courtCount,
  weekdayStart,
  poolDates
).map((m, index) => ({
  ...m,
  round: index + 1,
}));

    const standings = standingsByPool(poolMatches, approved);
    const playoffMatches = generatePlayoffMatches(standings, saturdayStart, courtCount);

    const allMatches = [...poolMatches, ...playoffMatches].map((m, index) => {
  const slotCode = m.slotDateId || m.slotDateCode || null;
  const foundPoolDate = slotCode ? poolDates.find((d) => d.id === slotCode) : null;

  const computedDayLabel = foundPoolDate
    ? `${foundPoolDate.label} • ${formatDateLabel(foundPoolDate.date)}${
        typeof m.dayLabel === "string" && m.dayLabel.includes("Fallback")
          ? " • Fallback"
          : ""
      }`
    : m.dayLabel;

  return {
    pool: m.pool,
    stage: m.stage,
    round: m.round ?? index + 1,
    court: m.court,
    p1: m.p1,
    p2: m.p2,
    s1: m.s1,
    s2: m.s2,
    status: m.status,
    day_label: computedDayLabel,
    slot_date_code: slotCode,
    start_time: m.startTime,
    end_time: m.endTime,
    preferred_slot: m.preferredSlot ?? false,
    format: m.format,
  };
});
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
    await loadAdminData();
  }

  async function updateMatchScore(id: number, key: "s1" | "s2", value: string) {
    const { data: existingMatch, error: fetchError } = await supabase
      .from("matches")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !existingMatch) {
      setMessage(`Could not load match: ${fetchError?.message || "Unknown error"}`);
      return;
    }

    const nextS1 = key === "s1" ? (value === "" ? null : Number(value)) : existingMatch.s1;
    const nextS2 = key === "s2" ? (value === "" ? null : Number(value)) : existingMatch.s2;

    const { error } = await supabase
      .from("matches")
      .update({
        s1: nextS1,
        s2: nextS2,
        status: nextS1 !== null && nextS2 !== null ? "final" : "upcoming",
      })
      .eq("id", id);

    if (error) {
      setMessage(`Score update error: ${error.message}`);
      return;
    }

    setMessage("Score updated.");
    await loadAdminData();
  }

  async function postAnnouncement() {
    if (!announcementForm.title.trim() || !announcementForm.body.trim()) {
      setMessage("Title and message are required.");
      return;
    }

    const { error } = await supabase.from("announcements").insert({
      title: announcementForm.title.trim(),
      body: announcementForm.body.trim(),
      priority: announcementForm.priority,
    });

    if (error) {
      setMessage(`Could not post announcement: ${error.message}`);
      return;
    }

    setAnnouncementForm({ title: "", body: "", priority: "info" });
    setMessage("Announcement posted.");
    await loadAdminData();
  }

  async function deleteAnnouncement(id: number) {
    const { error } = await supabase.from("announcements").delete().eq("id", id);
    if (error) {
      setMessage(`Could not delete announcement: ${error.message}`);
      return;
    }
    setMessage("Announcement deleted.");
    await loadAdminData();
  }

  async function toggleForfeit(id: number, forfeit: boolean) {
    const { error } = await supabase
      .from("matches")
      .update({ forfeit, s1: forfeit ? null : undefined, s2: forfeit ? null : undefined, status: forfeit ? "forfeit" : "upcoming" })
      .eq("id", id);

    if (error) {
      setMessage(`Forfeit update error: ${error.message}`);
      return;
    }

    setMessage(forfeit ? "Match marked as forfeit." : "Forfeit cleared.");
    await loadAdminData();
  }

  function exportDuprCsv() {
    const playerMap = Object.fromEntries(players.map((p) => [p.name, p]));
    const exportable = matches.filter(
      (m) => !m.forfeit && m.s1 !== null && m.s1 !== "" && m.s2 !== null && m.s2 !== ""
    );

    if (!exportable.length) {
      setMessage("No completed non-forfeit matches to export.");
      return;
    }

    const rows = exportable.map((m) => {
      const poolDate = poolDates.find((d) => d.id === m.slot_date_code);
      const date = poolDate ? poolDate.date : playoffDate;
      const p1 = playerMap[m.p1];
      const p2 = playerMap[m.p2];
      const eventName = `"${tournamentName.replace(/"/g, '""')}"`;
      return [
        "", "", "",                  // A, B, C blank
        "S",                         // matchType
        eventName,                   // event
        date || "",                  // date YYYY-MM-DD
        m.p1,                        // playerA1
        p1?.duprId || "",            // playerA1DuprId
        "",                          // playerA1ExternalId
        "", "", "",                  // playerA2 (blank — singles)
        m.p2,                        // playerB1
        p2?.duprId || "",            // playerB1DuprId
        "",                          // playerB1ExternalId
        "", "", "",                  // playerB2 (blank — singles)
        "",                          // column S blank
        m.s1, m.s2,                  // Game 1
        "", "", "", "", "", "", "", "", // Games 2–5 blank
        clubId,                      // clubId
      ].join(",");
    });

    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dupr_export.csv";
    a.click();
    URL.revokeObjectURL(url);
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
              Review registrations, approve players, generate schedule, and enter scores.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3 text-sm">
              <Badge variant="secondary">Pending: {pendingPlayers.length}</Badge>
              <Badge>Approved: {approvedPlayers.length}</Badge>
            </div>
            {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant={scheduleLocked ? "secondary" : "outline"}
                onClick={toggleScheduleLock}
                className="gap-2"
              >
                {scheduleLocked ? "🔒 Schedule Locked — Click to Unlock" : "🔓 Lock Schedule"}
              </Button>
              <Button
                onClick={() => setShowConfirmGenerate(true)}
                disabled={scheduleLocked}
                title={scheduleLocked ? "Unlock the schedule before regenerating" : undefined}
              >
                Generate Schedule
              </Button>
            </div>
            {showConfirmGenerate && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
                <p className="text-sm font-semibold text-destructive">
                  ⚠️ This will permanently delete all {matches.length} existing match{matches.length !== 1 ? "es" : ""} and regenerate the schedule from scratch. This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => { setShowConfirmGenerate(false); generateSchedule(); }}
                  >
                    Yes, regenerate
                  </Button>
                  <Button variant="outline" onClick={() => setShowConfirmGenerate(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
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
              <div key={player.id} className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <div className="text-lg font-semibold">{player.name}</div>
                    <div className="text-sm text-muted-foreground">{player.email}</div>
                    <div className="text-sm text-muted-foreground">Skill: {player.skill}</div>
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
              <div key={player.id} className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="space-y-1">
                  <div className="text-lg font-semibold">{player.name}</div>
                  <div className="text-sm text-muted-foreground">{player.email}</div>
                  <div className="text-sm text-muted-foreground">Skill: {player.skill}</div>
                  <div className="text-sm text-muted-foreground">
                    Availability: {renderAvailability(player.availability)}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle>Announcements</CardTitle>
            <CardDescription>Post updates visible to players on the public site.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3 rounded-2xl border p-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Title</label>
                <input
                  className="w-full rounded border px-3 py-2 text-sm"
                  placeholder="Announcement title"
                  value={announcementForm.title}
                  onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Message</label>
                <textarea
                  className="w-full rounded border px-3 py-2 text-sm font-mono"
                  rows={6}
                  placeholder={"Write your announcement...\n\nFormatting tips:\n- Start a line with '- ' for bullets\n- Leave a blank line between paragraphs"}
                  value={announcementForm.body}
                  onChange={(e) => setAnnouncementForm({ ...announcementForm, body: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Use <code className="bg-muted px-1 rounded">- item</code> for bullets · blank line between paragraphs · paste a URL or use <code className="bg-muted px-1 rounded">[text](url)</code> for links
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Priority</label>
                <select
                  className="rounded border px-3 py-2 text-sm bg-white"
                  value={announcementForm.priority}
                  onChange={(e) => setAnnouncementForm({ ...announcementForm, priority: e.target.value as Announcement["priority"] })}
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="important">Important</option>
                </select>
              </div>
              <Button onClick={postAnnouncement}>Post Announcement</Button>
            </div>

            {announcements.length === 0 ? (
              <p className="text-sm text-muted-foreground">No announcements posted yet.</p>
            ) : (
              announcements.map((a) => (
                <div key={a.id} className="rounded-2xl border bg-white p-4 shadow-sm space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{a.title}</span>
                      <Badge variant={
                        a.priority === "important" ? "destructive"
                        : a.priority === "warning" ? "secondary"
                        : "default"
                      }>
                        {a.priority}
                      </Badge>
                    </div>
                    <button
                      className="text-xs text-red-500 hover:underline"
                      onClick={() => deleteAnnouncement(a.id)}
                    >
                      Delete
                    </button>
                  </div>
                  <p className="text-sm text-muted-foreground">{a.body}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleDateString("en-US", {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                    })}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle>Score Entry</CardTitle>
            <CardDescription>Update scores for saved matches.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!matches.length && !loading ? (
              <p className="text-sm text-muted-foreground">No matches generated yet.</p>
            ) : null}

            {matches.map((match) => (
              <div key={match.id} className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-semibold">
                      {match.p1} vs {match.p2}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {match.day_label} • Court {match.court} • {match.format}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap">
                    {match.forfeit ? (
                      <span className="text-sm text-muted-foreground italic">Forfeit — not reported to DUPR</span>
                    ) : (
                      <>
                        <input
                          type="number"
                          className="w-20 rounded border px-2 py-1"
                          value={match.s1 ?? ""}
                          onChange={(e) => updateMatchScore(match.id, "s1", e.target.value)}
                        />
                        <span>to</span>
                        <input
                          type="number"
                          className="w-20 rounded border px-2 py-1"
                          value={match.s2 ?? ""}
                          onChange={(e) => updateMatchScore(match.id, "s2", e.target.value)}
                        />
                      </>
                    )}
                    <label className="flex items-center gap-1 text-sm text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!match.forfeit}
                        onChange={(e) => toggleForfeit(match.id, e.target.checked)}
                      />
                      Forfeit
                    </label>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="rounded-3xl shadow-sm">
          <CardHeader>
            <CardTitle>Export for DUPR</CardTitle>
            <CardDescription>
              Downloads a CSV of all completed, non-forfeit matches in the DUPR bulk import format.
              Forfeit matches are excluded automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">DUPR Club ID</label>
                <input
                  className="w-full rounded border px-3 py-2 text-sm"
                  placeholder="e.g. 123456789"
                  value={clubId}
                  onChange={(e) => setClubId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Found in your DUPR club settings.</p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Playoff / Bracket Day Date</label>
                <input
                  type="date"
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={playoffDate}
                  onChange={(e) => setPlayoffDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Used for semifinal and final matches.</p>
              </div>
            </div>
            <Button onClick={exportDuprCsv}>Download DUPR CSV</Button>
            <p className="text-xs text-muted-foreground">
              Pool play matches use their scheduled date automatically. After downloading, open in a spreadsheet editor to verify DUPR IDs before uploading.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}