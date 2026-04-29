import data from "../generated/dashboard-data.json";

export const dashboard = data;
export const basePath = data.basePath || "";

export function pageHref(path: string) {
  if (path.startsWith("http")) return path;
  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
}

export function formatDate(value?: string) {
  if (!value) return "Дата не указана";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatDateShort(value?: string) {
  if (!value) return "Без даты";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function ageText(birthDate?: string) {
  if (!birthDate) return "";
  const born = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(born.valueOf())) return "";
  const now = new Date();
  let years = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) years -= 1;
  if (years < 1) return "меньше года";
  return `${years} ${plural(years, "год", "года", "лет")}`;
}

export function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function compactList(items?: string[], max = 2) {
  return (items || []).filter(Boolean).slice(0, max);
}

export function excerpt(items?: string[], max = 160) {
  const text = (items || []).filter(Boolean).join(" ");
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

export function taskState(task: { dueDate?: string }) {
  if (!task.dueDate) return { bucket: "unknown", label: "Без даты" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${task.dueDate}T00:00:00`);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { bucket: "overdue", label: "Просрочено" };
  if (diffDays <= 7) return { bucket: "week", label: "На этой неделе" };
  if (diffDays <= 31) return { bucket: "month", label: "В этом месяце" };
  return { bucket: "later", label: "Позже" };
}

export function groupTasks(tasks: any[]) {
  const groups = [
    { id: "overdue", title: "Просрочено", tasks: [] as any[] },
    { id: "week", title: "На этой неделе", tasks: [] as any[] },
    { id: "month", title: "В этом месяце", tasks: [] as any[] },
    { id: "later", title: "Позже", tasks: [] as any[] },
    { id: "unknown", title: "Без даты", tasks: [] as any[] },
  ];
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const task of tasks) {
    const state = taskState(task);
    byId.get(state.bucket)?.tasks.push({ ...task, state });
  }
  for (const group of groups) {
    group.tasks.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  }
  return groups;
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

