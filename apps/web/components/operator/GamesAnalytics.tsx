// Fleet-wide GAMES analytics for the platform owner — adoption + engagement
// across every customer school. Every figure is an aggregate COUNT (PII-free by
// design; player identities never cross the tenant boundary — the pseudonymous
// Ultimate arena remains the only cross-school game surface). Rendered on the
// owner's /dashboard next to the business overview; data from
// GET /operator/games-analytics (platform.tenants.read).

import type { GamesAnalyticsDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi } from "@/components/charts/charts";
import { RCBars, RCDonut } from "@/components/charts/rc";
import { RC } from "@/components/charts/colors";

const MODE_LABEL: Record<string, string> = {
  DUEL: "Duel",
  RING: "Elimination Ring",
  RACE: "Class Race",
  LEAGUE_MATCH: "League match",
  KNOCKOUT_MATCH: "Knockout match",
  LIVE_QUIZ: "Live Quiz",
  TYPING_RACE: "Typing Race",
  HANGMAN: "Hangman",
  CHESS: "Chess",
  CHECKERS: "Checkers",
  LEAGUE: "League",
  KNOCKOUT: "Knockout",
  RACE_TOURNAMENT: "Race tournament",
};

const label = (k: string) => MODE_LABEL[k] ?? k;

function ModeTable({ stats }: { stats: Serialized<GamesAnalyticsDto>["guessing"] }) {
  const rows = Object.entries(stats);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th className="py-2 pr-3">Mode</th>
          <th className="py-2 pr-3 text-right">Total</th>
          <th className="py-2 pr-3 text-right">Live now</th>
          <th className="py-2 text-right">Last 30d</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, s]) => (
          <tr key={k} className="border-b border-border/60 last:border-0">
            <td className="py-2 pr-3">{label(k)}</td>
            <td className="tnum py-2 pr-3 text-right">{s.total.toLocaleString()}</td>
            <td className="tnum py-2 pr-3 text-right">
              {s.activeNow > 0 ? <span className="font-medium text-primary">{s.activeNow}</span> : "—"}
            </td>
            <td className="tnum py-2 text-right">{s.last30d.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function GamesAnalytics({ data }: { data: Serialized<GamesAnalyticsDto> | null }) {
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Games across the fleet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Games analytics are unavailable — the privileged database connection is not configured.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalGames =
    Object.values(data.guessing).reduce((n, s) => n + s.total, 0) +
    Object.values(data.arcade).reduce((n, s) => n + s.total, 0);
  const liveNow =
    Object.values(data.guessing).reduce((n, s) => n + s.activeNow, 0) +
    Object.values(data.arcade).reduce((n, s) => n + s.activeNow, 0);
  const last30d =
    Object.values(data.guessing).reduce((n, s) => n + s.last30d, 0) +
    Object.values(data.arcade).reduce((n, s) => n + s.last30d, 0);

  const adoption = [
    { label: "Games entitled", value: data.schools.gamesEntitled, color: RC.primary },
    { label: "Played in last 30d", value: data.schools.activeLast30d, color: RC.primarySoft },
    { label: "Switched off by school", value: data.schools.disabledBySetting, color: RC.muted },
  ];
  const compDonut = Object.entries(data.competitions.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({
      name: label(name),
      value,
      color: [RC.primary, RC.primarySoft, RC.primaryFaint][i % 3],
    }));
  const byGame = [
    ...Object.entries(data.guessing).map(([k, s]) => ({ label: label(k), value: s.last30d })),
    ...Object.entries(data.arcade).map(([k, s]) => ({ label: label(k), value: s.last30d })),
  ]
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Games across the fleet</h2>
        <p className="text-sm text-muted-foreground">
          Adoption and engagement for the learning-games suite — aggregate counts only, no player identities.
        </p>
      </div>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label="Schools playing"
          value={`${data.schools.activeLast30d.toLocaleString()}`}
          sub={`of ${data.schools.gamesEntitled.toLocaleString()} entitled (${data.schools.total.toLocaleString()} schools)`}
        />
        <Kpi
          label="Players · all time"
          value={data.players.total.toLocaleString()}
          sub={`${data.players.last30d.toLocaleString()} active last 30d`}
        />
        <Kpi
          label="Games created"
          value={totalGames.toLocaleString()}
          sub={`${last30d.toLocaleString()} in last 30d`}
        />
        <Kpi
          label="Live right now"
          value={liveNow.toLocaleString()}
          sub={`${data.competitions.active} competitions running`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Adoption</CardTitle>
            <CardDescription>
              Schools entitled to games vs actually playing; schools that switched games off themselves.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RCBars data={adoption} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Most played · last 30 days</CardTitle>
            <CardDescription>New games created per mode across the fleet.</CardDescription>
          </CardHeader>
          <CardContent>
            {byGame.length ? (
              <RCBars data={byGame} color={RC.primary} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No games created in the last 30 days.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Number-guessing modes</CardTitle>
            <CardDescription>The Dead &amp; Wounded core: duels, rings, races and competition matches.</CardDescription>
          </CardHeader>
          <CardContent>
            <ModeTable stats={data.guessing} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Classroom games</CardTitle>
            <CardDescription>Live Quiz sessions, Typing Race, Hangman, Chess and Checkers.</CardDescription>
          </CardHeader>
          <CardContent>
            <ModeTable stats={data.arcade} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Competitions</CardTitle>
            <CardDescription>
              {data.competitions.total.toLocaleString()} created · {data.competitions.active} active now.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {compDonut.length ? (
              <RCDonut data={compDonut} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No competitions yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ultimate — cross-school arena</CardTitle>
            <CardDescription>The one cross-tenant surface; pseudonymous handles only, two-tier consent.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Kpi label="Competitions" value={data.ultimate.competitions.toLocaleString()} sub={`${data.ultimate.active} active`} />
            <Kpi label="Arena entries" value={data.ultimate.participants.toLocaleString()} sub="pseudonymous participants" />
            <Kpi label="Schools enrolled" value={data.ultimate.schoolsEnrolled.toLocaleString()} sub="tier-1 school opt-in" />
            <Kpi label="Guardian consents" value={data.ultimate.consentedStudents.toLocaleString()} sub="tier-2, per student" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
