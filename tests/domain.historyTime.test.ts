import { expect, it } from "vitest";
import { historyTime } from "../src/domain/document/historyTime";

it("shows relative seconds and minutes, then the day and time before using the full date", () => {
  const now = new Date(2026, 10, 24, 15).getTime();
  expect(historyTime(now - 15_000, now)).toBe("15 seconds ago");
  expect(historyTime(now - 7_200_000 + 1, now)).toBe("119 minutes ago");
  expect(historyTime(now - 7_200_000, now)).toBe("Today at 1:00pm");
  expect(historyTime(new Date(2026, 10, 24, 10, 3).getTime(), now)).toBe("Today at 10:03am");
  expect(historyTime(new Date(2026, 10, 23, 0).getTime(), now)).toBe("Yesterday at 12:00am");
  expect(historyTime(new Date(2026, 10, 22, 17, 6).getTime(), now)).toBe("Last Sunday at 5:06pm");
  expect(historyTime(new Date(2026, 10, 17, 12).getTime(), now)).toBe("Last Tuesday at 12:00pm");
  const older = new Date(2026, 10, 16, 12).getTime();
  expect(historyTime(older, now)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(older));
});
