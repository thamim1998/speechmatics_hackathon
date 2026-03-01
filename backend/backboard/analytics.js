// backend/backboard/analytics.js

function safeParseMetadata(md) {
    if (!md) return null;
    if (typeof md === "string") {
      try { return JSON.parse(md); } catch { return null; }
    }
    return md;
  }
  
  function pickTimestamp(message, md) {
    return (
      md?.custom_timestamp ||
      message.timestamp ||
      message.created_at ||
      message.createdAt ||
      null
    );
  }
  
  function toDateKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  
  function inWindow(tsISO, fromMs, toMs) {
    const t = new Date(tsISO).getTime();
    if (Number.isNaN(t)) return false;
    return t >= fromMs && t < toMs;
  }
  
  function sumCounts(messages) {
    const countsByType = {};
    const countsBySource = {};
    const incidentsByDay = {};
    const incidentCountsByType = {};
    const sleepByDay = {}; // {day:{total,count}}
    const sleepWakeupsByDay = {}; // {day:{total,count}}
  
    for (const m of messages) {
      const md = safeParseMetadata(m.metadata || m.metadata_);
      const type = md?.type || "unknown";
      const source = md?.source || m.role || "unknown";
  
      countsByType[type] = (countsByType[type] || 0) + 1;
      countsBySource[source] = (countsBySource[source] || 0) + 1;
  
      const ts = pickTimestamp(m, md);
      const day = ts ? toDateKey(ts) : null;
  
      if (type === "incident") {
        if (day) incidentsByDay[day] = (incidentsByDay[day] || 0) + 1;
        // const it = md?.data?.incidentType || "unknown";
        // incidentCountsByType[it] = (incidentCountsByType[it] || 0) + 1;
        const itRaw = md?.data?.incidentType;
        const it = (typeof itRaw === 'string' && itRaw.trim()) ? itRaw : 'other';
        incidentCountsByType[it] = (incidentCountsByType[it] || 0) + 1;
      }
  
      if (type === "sleep" && day) {
        const duration = md?.data?.durationMinutes;
        if (typeof duration === "number") {
          if (!sleepByDay[day]) sleepByDay[day] = { total: 0, count: 0 };
          sleepByDay[day].total += duration;
          sleepByDay[day].count += 1;
        }
        const wakeUps = md?.data?.wakeUps;
        if (typeof wakeUps === "number") {
          if (!sleepWakeupsByDay[day]) sleepWakeupsByDay[day] = { total: 0, count: 0 };
          sleepWakeupsByDay[day].total += wakeUps;
          sleepWakeupsByDay[day].count += 1;
        }
      }
    }
  
    const avgSleepMinutesByDay = {};
    for (const [day, v] of Object.entries(sleepByDay)) {
      avgSleepMinutesByDay[day] = Math.round(v.total / v.count);
    }
  
    const avgWakeupsByDay = {};
    for (const [day, v] of Object.entries(sleepWakeupsByDay)) {
      avgWakeupsByDay[day] = Math.round((v.total / v.count) * 10) / 10;
    }
  
    return {
      countsByType,
      countsBySource,
      incidentsByDay,
      incidentCountsByType,
      avgSleepMinutesByDay,
      avgWakeupsByDay,
    };
  }
  
  function compute7DayWindows(messages, nowMs) {
    const dayMs = 24 * 60 * 60 * 1000;
    const toMs = nowMs;
    const fromMs = nowMs - 7 * dayMs;
    const prevToMs = fromMs;
    const prevFromMs = prevToMs - 7 * dayMs;
  
    const inLast7 = [];
    const inPrev7 = [];
  
    for (const m of messages) {
      const md = safeParseMetadata(m.metadata || m.metadata_);
      const ts = pickTimestamp(m, md);
      if (!ts) continue;
      if (inWindow(ts, fromMs, toMs)) inLast7.push(m);
      else if (inWindow(ts, prevFromMs, prevToMs)) inPrev7.push(m);
    }
  
    const last7Agg = sumCounts(inLast7);
    const prev7Agg = sumCounts(inPrev7);
  
    const delta7DaysByType = {};
    const allTypes = new Set([
      ...Object.keys(last7Agg.countsByType),
      ...Object.keys(prev7Agg.countsByType),
    ]);
  
    for (const t of allTypes) {
      const a = last7Agg.countsByType[t] || 0;
      const b = prev7Agg.countsByType[t] || 0;
      delta7DaysByType[t] = a - b;
    }
  
    return {
      last7: {
        fromISO: new Date(fromMs).toISOString(),
        toISO: new Date(toMs).toISOString(),
        countsByType: last7Agg.countsByType,
      },
      prev7: {
        fromISO: new Date(prevFromMs).toISOString(),
        toISO: new Date(prevToMs).toISOString(),
        countsByType: prev7Agg.countsByType,
      },
      delta7DaysByType,
      last7Agg,
      prev7Agg,
    };
  }
  
  function computeSleepFlags(avgSleepMinutesByDay, avgWakeupsByDay) {
    const flags = [];
    const days = Object.keys(avgSleepMinutesByDay).sort(); // ascending
    if (!days.length) return flags;
  
    // Flag: <5h sleep 2+ consecutive days
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      const min = avgSleepMinutesByDay[d];
      if (typeof min === "number" && min < 300) streak += 1;
      else break;
    }
    if (streak >= 2) {
      flags.push(`Low sleep streak: <5h for ${streak} day(s) in a row.`);
    }
  
    // Flag: wakeups increasing (compare last 3 days avg vs previous 3 days avg)
    const wDays = Object.keys(avgWakeupsByDay).sort();
    if (wDays.length >= 6) {
      const last3 = wDays.slice(-3);
      const prev3 = wDays.slice(-6, -3);
  
      const avg = (arr) => {
        const vals = arr.map((d) => avgWakeupsByDay[d]).filter((v) => typeof v === "number");
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
  
      const a = avg(prev3);
      const b = avg(last3);
      if (a != null && b != null && b - a >= 1) {
        flags.push(`Wake-ups increasing: last 3 days average (${b.toFixed(1)}) vs previous 3 (${a.toFixed(1)}).`);
      }
    }
  
    return flags;
  }
  
  export function summarizeTimeline(messages) {
    // Overall aggregation (all time / all messages you fetched)
    const overall = sumCounts(messages);
  
    // 7-day windows
    const nowMs = Date.now();
    const windows = compute7DayWindows(messages, nowMs);
  
    // Flags (sleep)
    const sleepFlags = computeSleepFlags(overall.avgSleepMinutesByDay, overall.avgWakeupsByDay);
  
    // Existing + new flags
    const flags = [];
    // example: elevated incidents overall
    const incidentTotal = Object.values(overall.incidentsByDay).reduce((a, b) => a + b, 0);
    if (incidentTotal >= 3) flags.push("Incident count is elevated in the selected period.");
    flags.push(...sleepFlags);
  
    return {
      // existing fields your UI already expects
      countsByType: overall.countsByType,
      countsBySource: overall.countsBySource,
      incidentsByDay: overall.incidentsByDay,
      avgSleepMinutesByDay: overall.avgSleepMinutesByDay,
      flags,
  
      // NEW fields
      incidentCountsByType: overall.incidentCountsByType,
      last7Days: windows.last7,
      prev7Days: windows.prev7,
      delta7DaysByType: windows.delta7DaysByType,
    };
  }