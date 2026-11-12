// Formatting helpers. All sim times are rendered in IST (Asia/Kolkata) regardless of viewer TZ.
const TZ = 'Asia/Kolkata'
const DAY = 86_400_000

/** ₹4.60 Cr · ₹18.5 L · ₹58,000 (Indian numbering). */
export function inr(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '−' : ''
  const a = Math.abs(n)
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(digits)} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2)} L`
  return `${sign}₹${Math.round(a).toLocaleString('en-IN')}`
}

/** ₹3,88,22,000 */
export function inrFull(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n < 0 ? '−' : ''}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`
}

/** Indian-style words for a budget input: "4 crore 60 lakh" */
export function inrWords(n: number): string {
  if (!n || n < 0) return ''
  const cr = Math.floor(n / 1e7)
  const lakh = Math.floor((n % 1e7) / 1e5)
  const rest = Math.round(n % 1e5)
  const parts: string[] = []
  if (cr) parts.push(`${cr} crore`)
  if (lakh) parts.push(`${lakh} lakh`)
  if (rest) parts.push(rest.toLocaleString('en-IN'))
  return parts.join(' ')
}

export function parseTime(iso: string): number {
  // date-only strings are anchored at IST midday to avoid TZ edge effects
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T12:00:00+05:30`) : Date.parse(iso)
}

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o })
const fDay = fmt({ day: '2-digit', month: 'short' })
const fDate = fmt({ day: '2-digit', month: 'short', year: 'numeric' })
const fWeekday = fmt({ weekday: 'short' })
const fTime = fmt({ hour: '2-digit', minute: '2-digit', hour12: false })
const fDateTime = fmt({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export const dayMonth = (iso: string) => fDay.format(parseTime(iso))
export const fullDate = (iso: string) => fDate.format(parseTime(iso))
export const timeOfDay = (iso: string) => fTime.format(parseTime(iso))
export const dateTime = (iso: string) => fDateTime.format(parseTime(iso)).replace(',', '')

/** "Tue 26 Jan 2027 14:00" */
export function simClock(iso: string): string {
  const t = parseTime(iso)
  return `${fWeekday.format(t)} ${fDate.format(t)} ${fTime.format(t)}`
}

/** Calendar-day index of `iso` relative to `startIso` (IST). */
export function simDay(iso: string, startIso: string): number {
  const d = (x: string) => {
    const t = parseTime(x) + 5.5 * 3600_000
    return Math.floor(t / DAY)
  }
  return d(iso) - d(startIso)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseTime(toIso) - parseTime(fromIso)) / DAY)
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)} %`

export function signed(n: number, unit = 'd'): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)} ${unit}`
}

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ')
}
