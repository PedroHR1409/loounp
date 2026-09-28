const GMT_MINUS_3_MS = 3 * 60 * 60 * 1000;

export type LinkedInSchedule = {
  iso: string;
  label: string;
  rationale: string;
};

const preferredWeekdayTimes: Record<number, number[]> = {
  1: [16, 12, 10],
  2: [16, 10, 12],
  3: [14, 10, 12],
  4: [16, 10, 12],
  5: [13, 10, 16],
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDateAtOffset(date: Date) {
  const shifted = new Date(date.getTime() - GMT_MINUS_3_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/** Chooses a future weekday slot using broad LinkedIn timing benchmarks. */
export function recommendLinkedInSlot(now = new Date()): LinkedInSchedule {
  const localToday = localDateAtOffset(now);

  for (let offset = 0; offset < 14; offset += 1) {
    const localDay = new Date(localToday.getTime() + offset * 86_400_000);
    const weekday = localDay.getUTCDay();
    const slots = preferredWeekdayTimes[weekday] ?? [];

    for (const hour of slots) {
      const instant = Date.UTC(
        localDay.getUTCFullYear(),
        localDay.getUTCMonth(),
        localDay.getUTCDate(),
        hour + 3,
      );
      if (instant <= now.getTime()) continue;

      const iso = `${localDay.getUTCFullYear()}-${pad(localDay.getUTCMonth() + 1)}-${pad(localDay.getUTCDate())}T${pad(hour)}:00:00-03:00`;
      const label = `${pad(localDay.getUTCDate())}/${pad(localDay.getUTCMonth() + 1)}/${localDay.getUTCFullYear()} às ${pad(hour)}:00 (GMT-03:00)`;
      const rationale =
        "Horário baseado em janelas gerais de atividade no LinkedIn; ajuste depois com os resultados do seu público.";
      return { iso, label, rationale };
    }
  }

  throw new Error("Não foi possível calcular um horário de publicação futuro.");
}

export type LinkedInPostRecord = {
  id: string;
  createdAt: string;
  sourceTitle: string;
  sourceKind: "article" | "idea";
  hooks: [string, string, string];
  selectedHook: string;
  post: string;
  angle: string;
  engagementRationale: string;
  recommendedAt: LinkedInSchedule;
};
