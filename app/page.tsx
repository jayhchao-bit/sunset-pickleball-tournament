"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Trophy, Medal, UserPlus, CalendarDays, ListChecks, Megaphone } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Announcement = {
  id: number;
  title: string;
  body: string;
  priority: "info" | "warning" | "important";
  created_at: string;
};

const MAX_PLAYERS = 10;
const PLAYOFF_MATCH_MINUTES = 50;
const PLAYOFF_BUFFER_MINUTES = 10;
const DEFAULT_SATURDAY_START = "09:00";
const DEFAULT_POOL_DATES = [
  { id: "wed1", label: "Wednesday 1", date: "2026-03-25" },
  { id: "thu1", label: "Thursday 1", date: "2026-03-26" },
  { id: "wed2", label: "Wednesday 2", date: "2026-04-01" },
  { id: "thu2", label: "Thursday 2", date: "2026-04-02" },
];

function chunkIntoPools(players: any[]) {
  const approved = players.filter((p) => p.status === "approved");
  const sorted = [...approved].sort((a, b) => {
    const skillA = Number.parseFloat(a.skill || "0");
    const skillB = Number.parseFloat(b.skill || "0");
    return skillB - skillA || a.name.localeCompare(b.name);
  });

  const poolA: any[] = [];
  const poolB: any[] = [];
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

function addMinutes(timeString: string, minutesToAdd: number) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const nextHours = Math.floor(totalMinutes / 60) % 24;
  const nextMinutes = totalMinutes % 60;
  return `${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`;
}

function formatTime(timeString: string) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatDateLabel(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function sortMatchesChronologically(
  matches: any[],
  poolDates: { id: string; label: string; date: string }[]
) {
  const dateOrder = new Map<string, number>();

  poolDates.forEach((d, index) => {
    dateOrder.set(d.id, index);
  });

  return [...matches].sort((a, b) => {
    const aDateOrder =
      a.slotDateId === "playoff" || a.slot_date_code === "playoff"
        ? 999
        : dateOrder.get(a.slotDateId || a.slot_date_code || "") ?? 999;

    const bDateOrder =
      b.slotDateId === "playoff" || b.slot_date_code === "playoff"
        ? 999
        : dateOrder.get(b.slotDateId || b.slot_date_code || "") ?? 999;

    if (aDateOrder !== bDateOrder) return aDateOrder - bDateOrder;
    if ((a.startTime || "") !== (b.startTime || "")) {
      return (a.startTime || "").localeCompare(b.startTime || "");
    }
    return (a.court || 0) - (b.court || 0);
  });
}
function getDisplayDayLabel(
  match: any,
  poolDates: { id: string; label: string; date: string }[]
) {
  const slotCode = match.slotDateId || match.slot_date_code || null;

  if (slotCode) {
    const found = poolDates.find((d) => d.id === slotCode);
    if (found) {
      const fallbackSuffix =
        typeof match.dayLabel === "string" && match.dayLabel.includes("Fallback")
          ? " • Fallback"
          : "";
      return `${found.label} • ${formatDateLabel(found.date)}${fallbackSuffix}`;
    }
  }

  return match.dayLabel || "";
}
function renderInline(text: string): React.ReactNode {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|https?:\/\/\S+/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(linkPattern)) {
    if (match.index! > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[0].startsWith("[")) {
      nodes.push(<a key={match.index} href={match[2]} target="_blank" rel="noopener noreferrer" className="underline text-primary">{match[1]}</a>);
    } else {
      nodes.push(<a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer" className="underline text-primary">{match[0]}</a>);
    }
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : text;
}

function renderBody(text: string): React.ReactNode {
  const blocks = text.split(/\n\n+/);
  return blocks.map((block, bi) => {
    const lines = block.split("\n").filter((l) => l.trim());
    const allBullets = lines.length > 0 && lines.every((l) => /^\s*[-*]\s/.test(l));
    if (allBullets) {
      return (
        <ul key={bi} className="list-disc list-inside text-sm text-muted-foreground space-y-0.5">
          {lines.map((l, li) => (
            <li key={li}>{renderInline(l.replace(/^\s*[-*]\s+/, ""))}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={bi} className="text-sm text-muted-foreground">
        {renderInline(block)}
      </p>
    );
  });
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

function standingsByPool(matches: any[], players: any[]) {
  const pools = chunkIntoPools(players);
  const poolOnly = matches.filter((m) => m.stage === "pool");
  return {
    A: computeStandings(poolOnly.filter((m) => m.pool === "A"), pools.A.map((p) => p.name)),
    B: computeStandings(poolOnly.filter((m) => m.pool === "B"), pools.B.map((p) => p.name)),
  };
}

function StatTable({ rows, title }: { rows: any[]; title: string }) {
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

export default function PickleballTournamentWebsite() {
  const [tournamentName, setTournamentName] = useState("Inaugural Sunset Men's Singles Pickleball Classic");
  const [eventDate, setEventDate] = useState("Bracket Play: April 11, 2026 at 9:00 AM");
  const [location, setLocation] = useState("Sunset Pickleball Courts");
  const [entryFee, setEntryFee] = useState("One belly rub for Mocha");
  const [courtCount, setCourtCount] = useState("2");
  const [saturdayStart, setSaturdayStart] = useState(DEFAULT_SATURDAY_START);
  const [poolDates, setPoolDates] = useState(DEFAULT_POOL_DATES);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [players, setPlayers] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [liveStatus, setLiveStatus] = useState("connecting");
  const [form, setForm] = useState({
    name: "",
    email: "",
    skill: "3.0",
    duprId: "",
    waiverSigned: false,
    availability: [] as string[],
  });
  const [message, setMessage] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState("all");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const loadPublicData = useCallback(async () => {
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
      setSaturdayStart(settingsData.saturday_start);
      setRegistrationOpen(settingsData.registration_open);
    }

    const { data: poolDateRows } = await supabase
      .from("pool_dates")
      .select("*")
      .order("event_date", { ascending: true });

    if (poolDateRows && poolDateRows.length) {
      const mappedPoolDates = poolDateRows.map((row: any) => ({
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

      (availabilityRows || []).forEach((row: any) => {
        const current = availabilityMap.get(row.player_id) || [];
        current.push(row.date_code);
        availabilityMap.set(row.player_id, current);
      });

      const mergedPlayers = approvedPlayersRows.map((player: any) => ({
        id: player.id,
        name: player.name,
        email: player.email,
        skill: String(player.skill),
        waiverSigned: player.waiver_signed,
        status: player.status,
        availability: availabilityMap.get(player.id) || [],
      }));

      setPlayers(mergedPlayers);
    } else {
      setPlayers([]);
    }

    const { data: matchRows } = await supabase
      .from("matches")
      .select("*")
      .order("stage", { ascending: true })
      .order("round", { ascending: true })
      .order("start_time", { ascending: true });

    const { data: announcementRows } = await supabase
      .from("announcements")
      .select("*")
      .order("created_at", { ascending: false });

    setAnnouncements((announcementRows as Announcement[]) || []);

    if (matchRows && matchRows.length) {
      const mappedMatches = matchRows.map((m: any) => ({
        id: m.id,
        pool: m.pool,
        stage: m.stage,
        round: m.round,
        court: m.court,
        p1: m.p1,
        p2: m.p2,
        s1: m.s1 ?? "",
        s2: m.s2 ?? "",
        status: m.status,
        dayLabel: m.day_label,
        slotDateId: m.slot_date_code,
        startTime: m.start_time,
        endTime: m.end_time,
        preferredSlot: m.preferred_slot,
        format: m.format,
      }));
      setMatches(mappedMatches);
    } else {
      setMatches([]);
    }
  }, []);

  useEffect(() => {
    loadPublicData();
  }, [loadPublicData]);

  useEffect(() => {
    const matchChannel = supabase
      .channel("public-matches-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "matches",
        },
        async () => {
          await loadPublicData();
        }
      )
      .subscribe((status) => {
        setLiveStatus(status);
      });

    const playerChannel = supabase
      .channel("public-players-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
        },
        async () => {
          await loadPublicData();
        }
      )
      .subscribe();

    const availabilityChannel = supabase
      .channel("public-availability-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "player_availability",
        },
        async () => {
          await loadPublicData();
        }
      )
      .subscribe();

    const announcementChannel = supabase
      .channel("public-announcements-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "announcements" },
        async () => { await loadPublicData(); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(matchChannel);
      supabase.removeChannel(playerChannel);
      supabase.removeChannel(availabilityChannel);
      supabase.removeChannel(announcementChannel);
    };
  }, [loadPublicData]);

const sortedMatches = useMemo(
  () => sortMatchesChronologically(matches, poolDates),
  [matches, poolDates]
);
const filteredMatches = useMemo(() => {
  if (selectedPlayer === "all") return sortedMatches;
  return sortedMatches.filter(
    (m) => m.p1 === selectedPlayer || m.p2 === selectedPlayer
  );
}, [sortedMatches, selectedPlayer]);
const approvedPlayers = players.filter((p) => p.status === "approved");
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
        dupr_id: form.duprId.trim() || null,
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

    setForm({ name: "", email: "", skill: "3.0", duprId: "", waiverSigned: false, availability: [] });
    setMessage("Registration submitted successfully. Once approved, your name will appear on the public player list.");
  };

  const toggleAvailability = (dateId: string) => {
    setForm((prev) => ({
      ...prev,
      availability: prev.availability.includes(dateId)
        ? prev.availability.filter((id) => id !== dateId)
        : [...prev.availability, dateId],
    }));
  };

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
                  <p className="mt-2 text-xs text-muted-foreground">Live status: {liveStatus}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 md:min-w-[280px]">
                  <Card className="rounded-2xl">
                    <CardContent className="p-4">
                      <div className="text-sm text-muted-foreground">Approved</div>
                      <div className="text-2xl font-bold">{approvedPlayers.length}</div>
                    </CardContent>
                  </Card>
                  <Card className="rounded-2xl">
                    <CardContent className="p-4">
                      <div className="text-sm text-muted-foreground">Completed</div>
                      <div className="text-2xl font-bold">{completed}</div>
                    </CardContent>
                  </Card>
                  <Card className="rounded-2xl">
                    <CardContent className="p-4">
                      <div className="text-sm text-muted-foreground">Upcoming</div>
                      <div className="text-2xl font-bold">{upcoming}</div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="announcements" className="space-y-4">
          <TabsList className="grid w-full grid-cols-6 rounded-2xl">
            <TabsTrigger value="announcements">Announcements</TabsTrigger>
            <TabsTrigger value="register">Registration</TabsTrigger>
            <TabsTrigger value="players">Players</TabsTrigger>
            <TabsTrigger value="standings">Standings</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="finals">Bracket</TabsTrigger>
          </TabsList>

          <TabsContent value="announcements" className="space-y-4">
            <Card className="rounded-3xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Megaphone className="h-5 w-5" /> Announcements
                </CardTitle>
                <CardDescription>Official updates from tournament organizers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {announcements.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No announcements yet.</p>
                ) : (
                  announcements.map((a) => (
                    <div key={a.id} className="rounded-2xl border p-4 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                        <span className="font-semibold">{a.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={
                            a.priority === "important" ? "destructive"
                            : a.priority === "warning" ? "secondary"
                            : "default"
                          }>
                            {a.priority}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(a.created_at).toLocaleDateString("en-US", {
                              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                            })}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-1">{renderBody(a.body)}</div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="register" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="rounded-3xl lg:col-span-2 shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <UserPlus className="h-5 w-5" /> Player Registration
                  </CardTitle>
                  <CardDescription>
                    {registrationOpen ? `Open now • ${Math.max(MAX_PLAYERS - approvedPlayers.length, 0)} spots left` : "Currently closed"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Full Name</Label>
                      <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Player name" />
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" />
                    </div>
                    <div className="space-y-2">
                      <Label>Skill Level</Label>
                      <Input value={form.skill} onChange={(e) => setForm({ ...form, skill: e.target.value })} placeholder="3.0 / 3.5 / 4.0" />
                    </div>
                    <div className="space-y-2">
                      <Label>DUPR ID <span className="text-muted-foreground font-normal">(optional)</span></Label>
                      <Input value={form.duprId} onChange={(e) => setForm({ ...form, duprId: e.target.value })} placeholder="e.g. BK5V6D" />
                      <p className="text-xs text-muted-foreground">Found on your DUPR profile. Used to report results after the tournament.</p>
                    </div>
                    <div className="space-y-2 md:col-span-2 rounded-2xl border p-4">
                      <Label className="mb-2 block font-medium">Pool Play Availability</Label>
                      <p className="mb-3 text-sm text-muted-foreground">
                        Please select at least 3 of the 4 pool-play nights you can reasonably attend. Selecting more availability gives us the best chance to build a fair schedule that works well for everyone.
                      </p>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {poolDates.map((option) => (
                          <Label key={option.id} className="flex items-start gap-3 rounded-xl border p-3">
                            <input
                              type="checkbox"
                              checked={form.availability.includes(option.id)}
                              onChange={() => toggleAvailability(option.id)}
                              className="mt-1"
                            />
                            <span>{option.label} • {formatDateLabel(option.date)}</span>
                          </Label>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2 md:col-span-2 rounded-2xl border p-4">
                      <Label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={form.waiverSigned}
                          onChange={(e) => setForm({ ...form, waiverSigned: e.target.checked })}
                          className="mt-1"
                        />
                        <span>I agree to the event waiver and understand I participate at my own risk.</span>
                      </Label>
                    </div>
                  </div>
                  <Button onClick={handleRegister} disabled={!registrationOpen}>Submit Registration</Button>
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
                  <p><span className="font-medium text-foreground">Playoffs:</span> Best 2 of 3 to 11</p>
                  <p><span className="font-medium text-foreground">Courts:</span> {courtCount}</p>
                  <p><span className="font-medium text-foreground">Pool Nights:</span> {poolDates.map((d) => `${d.label} (${formatDateLabel(d.date)})`).join(", ")}</p>
                  <p><span className="font-medium text-foreground">Capacity:</span> {MAX_PLAYERS} players</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="players" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <ListChecks className="h-5 w-5" /> Registered Players
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Waiver</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {players.map((player) => (
                        <TableRow key={player.id}>
                          <TableCell>
                            <div className="font-medium">{player.name}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={player.status === "approved" ? "default" : "secondary"}>
                              {player.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{player.waiverSigned ? "Yes" : "No"}</TableCell>
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
            <div className="grid grid-cols-1 gap-4">
              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <CalendarDays className="h-5 w-5" /> Match Schedule
                  </CardTitle>
                </CardHeader>
                <CardContent>
                    
                    <div className="mb-4 flex flex-col gap-2 md:w-80">
    <Label htmlFor="player-filter">Filter by player</Label>
    <select
      id="player-filter"
      className="rounded-md border px-3 py-2 bg-white"
      value={selectedPlayer}
      onChange={(e) => setSelectedPlayer(e.target.value)}
    >
      <option value="all">All players</option>
      {approvedPlayers.map((player) => (
        <option key={player.id} value={player.name}>
          {player.name}
        </option>
      ))}
    </select>
  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Round</TableHead>
                        <TableHead>Pool</TableHead>
                        <TableHead>Court</TableHead>
                        <TableHead>Match</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Fit</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredMatches.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>{m.round}</TableCell>
                          <TableCell>{m.pool}</TableCell>
                          <TableCell>{m.court}</TableCell>
                          <TableCell className="font-medium">{m.p1} vs {m.p2}</TableCell>
                          <TableCell>
  {getDisplayDayLabel(m, poolDates)}
  <div className="text-xs text-muted-foreground">
    {formatTime(m.startTime)}–{formatTime(m.endTime)}
  </div>
</TableCell>
                          <TableCell>{m.stage === "pool" ? (m.preferredSlot ? "Preferred" : "Fallback") : "Playoff"}</TableCell>
                          <TableCell>
                            <Badge variant={m.s1 !== "" && m.s2 !== "" ? "default" : "secondary"}>
                              {m.s1 !== "" && m.s2 !== "" ? `${m.s1}-${m.s2}` : "Upcoming"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
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
                    <div className="mt-1 text-xs text-muted-foreground">
                      {Number(courtCount) > 1
                        ? formatTime(saturdayStart)
                        : formatTime(addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES))} • Court {Number(courtCount) > 1 ? 2 : 1} • Best 2 of 3
                    </div>
                  </div>
                  <div className="rounded-2xl border p-4">
                    <div className="text-sm text-muted-foreground">Final</div>
                    <div className="mt-2 text-xl font-semibold">{finalists.final}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {Number(courtCount) > 1
                        ? formatTime(addMinutes(saturdayStart, PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES))
                        : formatTime(addMinutes(saturdayStart, 2 * (PLAYOFF_MATCH_MINUTES + PLAYOFF_BUFFER_MINUTES)))} • Court 1 • Best 2 of 3
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Tournament Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>Public page is view-only.</p>
                  <p>Registrations are saved to Supabase.</p>
                  <p>Schedule and scores are managed from the admin page.</p>
                  <p>Players can return anytime to check standings, schedule, and bracket.</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}