"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Trophy, Users, TimerReset, QrCode, Medal, Swords, UserPlus, CalendarDays, ShieldCheck, ListChecks, Wand2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

const MAX_PLAYERS = 10;
const WEEKDAY_MATCH_MINUTES = 30;
const WEEKDAY_BUFFER_MINUTES = 10;
const PLAYOFF_MATCH_MINUTES = 50;
const PLAYOFF_BUFFER_MINUTES = 10;
const DEFAULT_WEEKDAY_START = "18:00";
const DEFAULT_SATURDAY_START = "09:00";
const DEFAULT_POOL_DATES = [
  { id: "wed1", label: "Wednesday 1", date: "2026-03-25" },
  { id: "thu1", label: "Thursday 1", date: "2026-03-26" },
  { id: "wed2", label: "Wednesday 2", date: "2026-04-01" },
  { id: "thu2", label: "Thursday 2", date: "2026-04-02" },
];

const defaultPlayers: any[] = [];

function chunkIntoPools(players) {
  const approved = players.filter((p) => p.status === "approved");
  const sorted = [...approved].sort((a, b) => {
    const skillA = Number.parseFloat(a.skill || "0");
    const skillB = Number.parseFloat(b.skill || "0");
    return skillB - skillA || a.name.localeCompare(b.name);
  });

  const poolA = [];
  const poolB = [];
  let poolASkill = 0;
  let poolBSkill = 0;

  sorted.forEach((player, index) => {
    const skill = Number.parseFloat(player.skill || "0");
    const shouldGoToA =
      poolA.length < Math.ceil(sorted.length / 2) &&
      (poolB.length >= Math.floor(sorted.length / 2) || poolASkill <= poolBSkill || index % 2 === 0);

    if (shouldGoToA) {
      poolA.push(player);
      poolASkill += skill;
    } else {
      poolB.push(player);
      poolBSkill += skill;
    }
  });

  return { A: poolA, B: poolB };
}

function addMinutes(timeString, minutesToAdd) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const nextHours = Math.floor(totalMinutes / 60) % 24;
  const nextMinutes = totalMinutes % 60;
  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

function formatTime(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatDateLabel(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getPlayerAvailabilityMap(players) {
  return Object.fromEntries(players.map((player) => [player.name, player.availability || []]));
}

function scoreMatchForSlot(match, slot, scheduledCounts, availabilityMap) {
  const p1Avail = availabilityMap[match.p1] || [];
  const p2Avail = availabilityMap[match.p2] || [];
  const bothAvailable = p1Avail.includes(slot.dateId) && p2Avail.includes(slot.dateId);
  const balancePenalty = (scheduledCounts[match.p1] || 0) + (scheduledCounts[match.p2] || 0);
  return (bothAvailable ? 100 : 0) - balancePenalty;
}

function buildPoolSlots(courtCount = 2, weekdayStart = DEFAULT_WEEKDAY_START, poolDates = DEFAULT_POOL_DATES) {
  const times = [
    weekdayStart,
    addMinutes(weekdayStart, WEEKDAY_MATCH_MINUTES + WEEKDAY_BUFFER_MINUTES),
    addMinutes(weekdayStart, 2 * (WEEKDAY_MATCH_MINUTES + WEEKDAY_BUFFER_MINUTES)),
  ];

  return poolDates.flatMap((day) =>
    times.map((time, index) => ({
      id: `${day.id}-${index + 1}`,
      dateId: day.id,
      dayLabel: `${day.label} • ${formatDateLabel(day.date)}`,
      startTime: time,
      endTime: addMinutes(time, WEEKDAY_MATCH_MINUTES),
      courtCount,
    }))
  );
}

function assignMatchesToAvailabilitySlots(rawMatches, playersInPool, courtCount = 2, weekdayStart = DEFAULT_WEEKDAY_START, poolDates = DEFAULT_POOL_DATES) {
  const availabilityMap = getPlayerAvailabilityMap(playersInPool);
  const slots = buildPoolSlots(courtCount, weekdayStart, poolDates);
  const scheduledCounts = Object.fromEntries(playersInPool.map((p) => [p.name, 0]));
  const unassigned = rawMatches.map((m) => ({ ...m }));
  const scheduled = [];

  slots.forEach((slot) => {
    const usedPlayers = new Set();
    for (let court = 1; court <= courtCount; court += 1) {
      const eligible = unassigned.filter(
        (m) => !m.assigned && !usedPlayers.has(m.p1) && !usedPlayers.has(m.p2)
      );
      if (!eligible.length) break;

      eligible.sort((a, b) => scoreMatchForSlot(b, slot, scheduledCounts, availabilityMap) - scoreMatchForSlot(a, slot, scheduledCounts, availabilityMap));
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
        round: scheduled.filter((m) => m.slotId === slot.id).length + 1,
        court,
        slotId: slot.id,
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
      round: 99,
      court: (index % courtCount) + 1,
      slotId: `${slot.id}-fallback-${index}`,
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

function generateRoundRobinMatches(playersInPool, poolLabel, courtCount = 2, startId = 1, weekdayStart = DEFAULT_WEEKDAY_START, poolDates = DEFAULT_POOL_DATES) {
  const matches = [];
  let id = startId;
  for (let i = 0; i < playersInPool.length; i += 1) {
    for (let j = i + 1; j < playersInPool.length; j += 1) {
      matches.push({
        id: id++,
        pool: poolLabel,
        stage: "pool",
        round: 1,
        court: 1,
        dayLabel: "Weekday Pool Play",
        startTime: weekdayStart,
        endTime: addMinutes(weekdayStart, WEEKDAY_MATCH_MINUTES),
        format: "1 game to 11",
        p1: playersInPool[i].name,
        p2: playersInPool[j].name,
        s1: "",
        s2: "",
        status: "upcoming",
      });
    }
  }

  return assignMatchesToAvailabilitySlots(matches, playersInPool, courtCount, weekdayStart, poolDates);
}

function generatePlayoffMatches(standings, startId, saturdayStart = DEFAULT_SATURDAY_START, courtCount = 2) {
  const a1 = standings.A[0]?.player || "Pool A #1";
  const a2 = standings.A[1]?.player || "Pool A #2";
  const b1 = standings.B[0]?.player || "Pool B #1";
  const b2 = standings.B[1]?.player || "Pool B #2";

  const semi1Start = saturdayStart;
  const semi2Start = courtCount > 1 ? saturdayStart : addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES);
  const finalStart = courtCount > 1
    ? addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES)
    : addMinutes(semi2Start, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES);

  return [
    {
      id: startId,
      pool: "Playoff",
      stage: "semifinal",
      round: 1,
      court: 1,
      dayLabel: "Saturday Bracket Play",
      startTime: semi1Start,
      endTime: addMinutes(semi1Start, PLAYOFF_MATCH_MINUTES),
      format: "Best 2 of 3 to 11",
      p1: a1,
      p2: b2,
      s1: "",
      s2: "",
      status: "upcoming",
    },
    {
      id: startId + 1,
      pool: "Playoff",
      stage: "semifinal",
      round: 1,
      court: courtCount > 1 ? 2 : 1,
      dayLabel: "Saturday Bracket Play",
      startTime: semi2Start,
      endTime: addMinutes(semi2Start, PLAYOFF_MATCH_MINUTES),
      format: "Best 2 of 3 to 11",
      p1: b1,
      p2: a2,
      s1: "",
      s2: "",
      status: "upcoming",
    },
    {
      id: startId + 2,
      pool: "Playoff",
      stage: "final",
      round: 2,
      court: 1,
      dayLabel: "Saturday Bracket Play",
      startTime: finalStart,
      endTime: addMinutes(finalStart, PLAYOFF_MATCH_MINUTES),
      format: "Best 2 of 3 to 11",
      p1: "Winner Semi 1",
      p2: "Winner Semi 2",
      s1: "",
      s2: "",
      status: "upcoming",
    },
  ];
}

function generateTournamentMatches(players, courtCount = 2, weekdayStart = DEFAULT_WEEKDAY_START, saturdayStart = DEFAULT_SATURDAY_START, poolDates = DEFAULT_POOL_DATES) {
  const pools = chunkIntoPools(players);
  const matchesA = generateRoundRobinMatches(pools.A, "A", courtCount, 1, weekdayStart, poolDates);
  const matchesB = generateRoundRobinMatches(pools.B, "B", courtCount, matchesA.length + 1, weekdayStart, poolDates);
  const poolMatches = [...matchesA, ...matchesB];
  const poolStandings = standingsByPool(poolMatches, players);
  const playoffs = generatePlayoffMatches(poolStandings, poolMatches.length + 1, saturdayStart, courtCount);
  return [...poolMatches, ...playoffs];
}

function computeStandings(matches, playerNames) {
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
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || m.s1 === "" || m.s2 === "") return;

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
    .map((r) => ({ ...r, diff: r.pf - r.pa }))
    .sort((a, b) => b.wins - a.wins || b.diff - a.diff || b.pf - a.pf || a.player.localeCompare(b.player));
}

function standingsByPool(matches, players) {
  const pools = chunkIntoPools(players);
  const poolOnly = matches.filter((m) => m.stage === "pool");
  return {
    A: computeStandings(poolOnly.filter((m) => m.pool === "A"), pools.A.map((p) => p.name)),
    B: computeStandings(poolOnly.filter((m) => m.pool === "B"), pools.B.map((p) => p.name)),
  };
}

function StatTable({ rows, title }) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Medal className="h-5 w-5" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Player</TableHead>
              <TableHead>W</TableHead>
              <TableHead>L</TableHead>
              <TableHead>PF</TableHead>
              <TableHead>PA</TableHead>
              <TableHead>Diff</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, idx) => (
              <TableRow key={row.player}>
                <TableCell>{idx + 1}</TableCell>
                <TableCell className="font-medium">{row.player}</TableCell>
                <TableCell>{row.wins}</TableCell>
                <TableCell>{row.losses}</TableCell>
                <TableCell>{row.pf}</TableCell>
                <TableCell>{row.pa}</TableCell>
                <TableCell>{row.diff}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MatchEditor({ match, onChange }) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl border p-4 md:grid-cols-12 md:items-center">
      <div className="md:col-span-2">
        <div className="text-sm font-semibold">{match.stage === "pool" ? `Pool ${match.pool}` : match.stage === "semifinal" ? "Semifinal" : "Final"}</div>
        <div className="text-xs text-muted-foreground">{match.dayLabel} • {formatTime(match.startTime)}–{formatTime(match.endTime)}</div>
      </div>
      <div className="md:col-span-4">
        <div className="font-medium">{match.p1} vs {match.p2}</div>
        <div className="text-xs text-muted-foreground">Court {match.court} • {match.format}</div>
      </div>
      <div className="md:col-span-4 flex items-center gap-2">
        <Input type="number" min="0" value={match.s1} onChange={(e) => onChange(match.id, "s1", e.target.value)} placeholder={match.p1} />
        <span className="text-sm text-muted-foreground">to</span>
        <Input type="number" min="0" value={match.s2} onChange={(e) => onChange(match.id, "s2", e.target.value)} placeholder={match.p2} />
      </div>
      <div className="md:col-span-2 flex justify-start md:justify-end">
        <Badge variant={match.s1 !== "" && match.s2 !== "" ? "default" : "secondary"}>
          {match.s1 !== "" && match.s2 !== "" ? "Final" : "Upcoming"}
        </Badge>
      </div>
    </div>
  );
}

export default function PickleballTournamentWebsite() {
  const [tournamentName, setTournamentName] = useState("Inaugural Sunset Men's Singles Pickleball Classic");
  const [eventDate, setEventDate] = useState("Bracket Play: April 11, 2026 at 9:00 AM");
  const [location, setLocation] = useState("Sunset Pickleball Courts");
  const [entryFee, setEntryFee] = useState("One belly rub for Mocha");
  const [courtCount, setCourtCount] = useState("2");
  const [weekdayStart, setWeekdayStart] = useState(DEFAULT_WEEKDAY_START);
  const [saturdayStart, setSaturdayStart] = useState(DEFAULT_SATURDAY_START);
  const [adminPassword, setAdminPassword] = useState("pickleball123");
  const [poolDates, setPoolDates] = useState(DEFAULT_POOL_DATES);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [players, setPlayers] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [showAdmin, setShowAdmin] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", skill: "3.0", waiverSigned: false, availability: [] });
  const [message, setMessage] = useState("");
useEffect(() => {
  async function loadPublicData() {
    const { data: settingsData } = await supabase
      .from("tournament_settings")
      .select("*")
      .limit(1)
      .maybeSingle();

    if (settingsData) {
      setTournamentName(settingsData.tournament_name);
      setEventDate(settingsData.event_date);
      setLocation(settingsData.location);
      setEntryFee(settingsData.entry_fee);
      setCourtCount(String(settingsData.court_count));
      setWeekdayStart(settingsData.weekday_start);
      setSaturdayStart(settingsData.saturday_start);
      setRegistrationOpen(settingsData.registration_open);
    }

    const { data: poolDateRows } = await supabase
      .from("pool_dates")
      .select("*")
      .order("event_date", { ascending: true });

    if (poolDateRows && poolDateRows.length) {
      const mappedPoolDates = poolDateRows.map((row) => ({
        id: row.code,
        label: row.label,
        date: row.event_date,
      }));
      setPoolDates(mappedPoolDates);
    }

    const { data: approvedPlayersRows } = await supabase
      .from("players")
      .select("*")
      .eq("status", "approved")
      .order("created_at", { ascending: true });

    const { data: availabilityRows } = await supabase
      .from("player_availability")
      .select("*");

    if (approvedPlayersRows) {
      const availabilityMap = new Map<number, string[]>();

      (availabilityRows || []).forEach((row) => {
        const current = availabilityMap.get(row.player_id) || [];
        current.push(row.date_code);
        availabilityMap.set(row.player_id, current);
      });

      const mergedPlayers = approvedPlayersRows.map((player) => ({
        id: player.id,
        name: player.name,
        email: player.email,
        skill: String(player.skill),
        waiverSigned: player.waiver_signed,
        status: player.status,
        availability: availabilityMap.get(player.id) || [],
      }));

      setPlayers(mergedPlayers);
    }
  }

  loadPublicData();
}, []);
  const approvedPlayers = players.filter((p) => p.status === "approved");
  const pendingPlayers = players.filter((p) => p.status === "pending");
  const standings = useMemo(() => standingsByPool(matches, players), [matches, players]);
  const completed = matches.filter((m) => m.s1 !== "" && m.s2 !== "").length;
  const upcoming = matches.length - completed;
  const pools = useMemo(() => chunkIntoPools(players), [players]);

  const finalists = useMemo(() => {
    const a1 = standings.A[0]?.player || "TBD";
    const a2 = standings.A[1]?.player || "TBD";
    const b1 = standings.B[0]?.player || "TBD";
    const b2 = standings.B[1]?.player || "TBD";
    return {
      semi1: `${a1} vs ${b2}`,
      semi2: `${b1} vs ${a2}`,
      final: "Winner Semi 1 vs Winner Semi 2",
    };
  }, [standings]);

  const rebuildSchedule = (nextPlayers, nextPoolDates = poolDates) => {
    const generated = generateTournamentMatches(nextPlayers, Number(courtCount), weekdayStart, saturdayStart, nextPoolDates);
    setMatches(generated);
  };

const handleRegister = async () => {
  if (!registrationOpen) {
    setMessage("Registration is currently closed.");
    return;
  }
  if (!form.name) {
    setMessage("Please enter your name.");
    return;
  }
  if (!form.email) {
    setMessage("Please enter your email.");
    return;
  }
  if (!form.waiverSigned) {
    setMessage("Player must agree to the waiver before registering.");
    return;
  }
  if (form.availability.length < 3) {
    setMessage("Please select at least 3 of the 4 pool-play nights so we can build the best schedule for everyone.");
    return;
  }

const { data: newPlayer, error: playerError } = await supabase
  .from("players")
  .insert({
    name: form.name.trim(),
    email: form.email.trim(),
    skill: Number(form.skill),
    waiver_signed: form.waiverSigned,
    status: "pending",
  })
  .select("id")
  .single();

  if (playerError || !newPlayer) {
  setMessage(`Registration error: ${playerError?.message || "Unknown error"}`);
  return;
}

  const availabilityPayload = form.availability.map((dateCode) => ({
    player_id: newPlayer.id,
    date_code: dateCode,
  }));

  const { error: availabilityError } = await supabase
    .from("player_availability")
    .insert(availabilityPayload);

if (availabilityError) {
  setMessage(`Availability error: ${availabilityError.message || "Unknown error"}`);
  return;
  }

  setForm({ name: "", email: "", skill: "3.0", waiverSigned: false, availability: [] });
  setMessage("Registration submitted successfully. Once approved, your name will appear on the public player list.");
};

  const approvePlayer = (id) => {
    const next = players.map((p) => (p.id === id ? { ...p, status: "approved" } : p));
    setPlayers(next);
    rebuildSchedule(next);
  };

  const toggleAvailability = (dateId) => {
    setForm((prev) => ({
      ...prev,
      availability: prev.availability.includes(dateId)
        ? prev.availability.filter((id) => id !== dateId)
        : [...prev.availability, dateId],
    }));
  };

  const updatePoolDate = (id, nextDate) => {
    const nextPoolDates = poolDates.map((item) => (item.id === id ? { ...item, date: nextDate } : item));
    setPoolDates(nextPoolDates);
    rebuildSchedule(players, nextPoolDates);
  };

  const removePlayer = (id) => {
    const next = players.filter((p) => p.id !== id);
    setPlayers(next);
    rebuildSchedule(next);
  };

  const handleMatchChange = (id, key, value) => {
    setMatches((prev) => prev.map((m) => (m.id === id ? { ...m, [key]: value, status: key === "s1" || key === "s2" ? "final" : m.status } : m)));
  };

  const resetScores = () => rebuildSchedule(players);

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="rounded-3xl lg:col-span-2 shadow-sm">
            <CardContent className="p-6 md:p-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-sm shadow-sm">
                    <Trophy className="h-4 w-4" /> Live Tournament Website
                  </div>
                  <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{tournamentName}</h1>
                  <p className="mt-2 text-base text-muted-foreground">{eventDate} • {location}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 md:min-w-[280px]">
                  <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-sm text-muted-foreground">Approved</div><div className="text-2xl font-bold">{approvedPlayers.length}</div></CardContent></Card>
                  <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-sm text-muted-foreground">Pending</div><div className="text-2xl font-bold">{pendingPlayers.length}</div></CardContent></Card>
                  <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-sm text-muted-foreground">Completed</div><div className="text-2xl font-bold">{completed}</div></CardContent></Card>
                  <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-sm text-muted-foreground">Upcoming</div><div className="text-2xl font-bold">{upcoming}</div></CardContent></Card>
                </div>
              </div>
            </CardContent>
          </Card>

        </div>

        <Tabs defaultValue="register" className="space-y-4">
          <TabsList className="grid w-full grid-cols-5 rounded-2xl">
            <TabsTrigger value="register">Registration</TabsTrigger>
            <TabsTrigger value="players">Players</TabsTrigger>
            <TabsTrigger value="standings">Standings</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="finals">Bracket</TabsTrigger>
          </TabsList>

          <TabsContent value="register" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="rounded-3xl lg:col-span-2 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg"><UserPlus className="h-5 w-5" /> Player Registration</CardTitle>
                  <CardDescription>{registrationOpen ? `Open now • ${Math.max(MAX_PLAYERS - players.length, 0)} spots left` : "Currently closed"}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2"><Label>Full Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Player name" /></div>
                    <div className="space-y-2"><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" /></div>
                    <div className="space-y-2"><Label>Skill Level</Label><Input value={form.skill} onChange={(e) => setForm({ ...form, skill: e.target.value })} placeholder="3.0 / 3.5 / 4.0" /></div>
                    <div className="space-y-2 md:col-span-2 rounded-2xl border p-4">
                      <Label className="mb-2 block font-medium">Pool Play Availability</Label>
                      <p className="mb-3 text-sm text-muted-foreground">Please select at least 3 of the 4 pool-play nights you can reasonably attend. Selecting more availability gives us the best chance to build a fair schedule that works well for everyone.</p>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {poolDates.map((option) => (
                          <Label key={option.id} className="flex items-start gap-3 rounded-xl border p-3">
                            <input type="checkbox" checked={form.availability.includes(option.id)} onChange={() => toggleAvailability(option.id)} className="mt-1" />
                            <span>{option.label} • {formatDateLabel(option.date)}</span>
                          </Label>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2 md:col-span-2 rounded-2xl border p-4">
                      <Label className="flex items-start gap-3">
                        <input type="checkbox" checked={form.waiverSigned} onChange={(e) => setForm({ ...form, waiverSigned: e.target.checked })} className="mt-1" />
                        <span>I agree to the event waiver and understand I participate at my own risk.</span>
                      </Label>
                    </div>
                  </div>
                  <Button onClick={handleRegister} disabled={!registrationOpen || players.length >= MAX_PLAYERS}>Submit Registration</Button>
                  {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Event Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p><span className="font-medium text-foreground">Name:</span> {tournamentName}</p>
                  <p><span className="font-medium text-foreground">Date:</span> {eventDate}</p>
                  <p><span className="font-medium text-foreground">Location:</span> {location}</p>
                  <p><span className="font-medium text-foreground">Entry Fee:</span> {entryFee}</p>
                  <p><span className="font-medium text-foreground">Format:</span> Singles, round robin pool play, then Saturday semifinals and final</p>
                  <p><span className="font-medium text-foreground">Pool Matches:</span> 1 game to 11, scheduled in 40-minute blocks</p>
                  <p><span className="font-medium text-foreground">Playoffs:</span> Best 2 of 3 to 11, scheduled in 60-minute blocks</p>
                  <p><span className="font-medium text-foreground">Courts:</span> {courtCount}</p>
                  <p><span className="font-medium text-foreground">Pool Nights:</span> {poolDates.map((d) => `${d.label} (${formatDateLabel(d.date)})`).join(", ")}</p>
                  <p><span className="font-medium text-foreground">Capacity:</span> {MAX_PLAYERS} players</p>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm xl:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg">Pool Night Dates</CardTitle>
                  <CardDescription>Edit the pool-play Wednesday and Thursday dates, then rebuild the schedule.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {poolDates.map((poolDate) => (
                    <div key={poolDate.id} className="space-y-2 rounded-2xl border p-4">
                      <div className="font-medium">{poolDate.label}</div>
                      <Input type="date" value={poolDate.date} onChange={(e) => updatePoolDate(poolDate.id, e.target.value)} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="players" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg"><ListChecks className="h-5 w-5" /> Registered Players</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Waiver</TableHead>
                        {showAdmin ? <TableHead>Action</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {players.map((player) => (
                        <TableRow key={player.id}>
                          <TableCell>
                            <div className="font-medium">{player.name}</div>
                            {showAdmin && player.email ? <div className="text-xs text-muted-foreground">{player.email}</div> : null}
                            <div className="text-xs text-muted-foreground">Waiver: {player.waiverSigned ? "Signed" : "Missing"}</div>
                            <div className="text-xs text-muted-foreground">Avail: {(player.availability || []).map((id) => poolDates.find((d) => d.id === id)?.label).filter(Boolean).join(", ") || "None"}</div>
                          </TableCell>
                          <TableCell><Badge variant={player.status === "approved" ? "default" : "secondary"}>{player.status}</Badge></TableCell>
                          <TableCell>{player.waiverSigned ? "Yes" : "No"}</TableCell>
                          {showAdmin ? (
                            <TableCell>
                              <div className="flex gap-2">
                                {player.status !== "approved" ? <Button size="sm" onClick={() => approvePlayer(player.id)}>Approve</Button> : null}
                                <Button size="sm" variant="outline" onClick={() => removePlayer(player.id)}>Remove</Button>
                              </div>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Pool Assignment Preview</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border p-4">
                    <div className="mb-3 font-semibold">Pool A</div>
                    <div className="space-y-2">{pools.A.map((p) => <div key={p.id}>{p.name}</div>)}</div>
                  </div>
                  <div className="rounded-2xl border p-4">
                    <div className="mb-3 font-semibold">Pool B</div>
                    <div className="space-y-2">{pools.B.map((p) => <div key={p.id}>{p.name}</div>)}</div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="standings" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <StatTable rows={standings.A} title="Pool A Standings" />
              <StatTable rows={standings.B} title="Pool B Standings" />
            </div>
          </TabsContent>

          <TabsContent value="schedule" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg"><CalendarDays className="h-5 w-5" /> Match Schedule</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Round</TableHead>
                        <TableHead>Pool</TableHead>
                        <TableHead>Court</TableHead>
                        <TableHead>Match</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matches.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>{m.round}</TableCell>
                          <TableCell>{m.pool}</TableCell>
                          <TableCell>{m.court}</TableCell>
                          <TableCell className="font-medium">{m.p1} vs {m.p2}</TableCell>
                          <TableCell>{m.dayLabel}<div className="text-xs text-muted-foreground">{formatTime(m.startTime)}–{formatTime(m.endTime)}</div></TableCell>
                          <TableCell>{m.stage === "pool" ? (m.preferredSlot ? "Preferred" : "Fallback") : "Playoff"}</TableCell>
                          <TableCell>
                            <Badge variant={m.s1 !== "" && m.s2 !== "" ? "default" : "secondary"}>{m.s1 !== "" && m.s2 !== "" ? `${m.s1}-${m.s2}` : "Upcoming"}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg"><Swords className="h-5 w-5" /> Score Entry</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 max-h-[620px] overflow-auto">
                  {matches.map((match) => (
                    <MatchEditor key={match.id} match={match} onChange={handleMatchChange} />
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="finals" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="rounded-3xl shadow-sm lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg">Projected Bracket</CardTitle>
                  <CardDescription>Top 2 players from each pool advance. Semifinals and final are best 2 of 3.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded-2xl border p-4">
                    <div className="text-sm text-muted-foreground">Semifinal 1</div>
                    <div className="mt-2 text-xl font-semibold">{finalists.semi1}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatTime(saturdayStart)} • Court 1 • Best 2 of 3</div>
                  </div>
                  <div className="rounded-2xl border p-4">
                    <div className="text-sm text-muted-foreground">Semifinal 2</div>
                    <div className="mt-2 text-xl font-semibold">{finalists.semi2}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{Number(courtCount) > 1 ? formatTime(saturdayStart) : formatTime(addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES))} • Court {Number(courtCount) > 1 ? 2 : 1} • Best 2 of 3</div>
                  </div>
                  <div className="rounded-2xl border p-4">
                    <div className="text-sm text-muted-foreground">Final</div>
                    <div className="mt-2 text-xl font-semibold">{finalists.final}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{Number(courtCount) > 1 ? formatTime(addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES)) : formatTime(addMinutes(saturdayStart, 2 * (PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES)))} • Court 1 • Best 2 of 3</div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Production Next Step</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>1. Save registrations, waiver status, and matches into Supabase.</p>
                  <p>2. Put admin approval and score entry behind a real password login.</p>
                  <p>3. Publish on Vercel for a public live URL.</p>
                  <p>4. Save player availability and use it to auto-build the pool schedule.</p>
                  <p>5. Use the collected email addresses for confirmations and match reminders when you connect this to Supabase or an email service.</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
