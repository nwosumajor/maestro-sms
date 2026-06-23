import { Duel } from "./match";
import { InMemoryGameStore } from "./store";

describe("InMemoryGameStore (spec §9 persistence seam)", () => {
  const makeGame = (id: string) => new Duel({ id, difficultyLength: 4 });

  it("saves, gets, lists, and deletes games", () => {
    const store = new InMemoryGameStore();
    expect(store.get("a")).toBeUndefined();
    expect(store.list()).toEqual([]);

    const a = makeGame("a");
    const b = makeGame("b");
    store.save(a);
    store.save(b);
    expect(store.get("a")).toBe(a);
    expect(store.list()).toHaveLength(2);

    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.get("a")).toBeUndefined();
    expect(store.list()).toEqual([b]);
  });

  it("save is an upsert keyed by id", () => {
    const store = new InMemoryGameStore();
    const first = makeGame("g");
    const second = makeGame("g");
    store.save(first);
    store.save(second);
    expect(store.list()).toHaveLength(1);
    expect(store.get("g")).toBe(second);
  });
});
