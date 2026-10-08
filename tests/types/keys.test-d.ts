import { describe, expectTypeOf, it } from "vitest";
import { EasySearch, type KeyPath, type SearchResult } from "../../src/index.js";

interface Post {
  id: number;
  title: string;
  published: boolean;
  createdAt: Date;
  author: { name: string; profile?: { bio: string } };
  tags: string[];
  comments: { body: string; likes: number }[];
}

declare function getPosts(): Promise<Post[]>;

describe("KeyPath", () => {
  it("lists searchable dot-notation paths only", () => {
    expectTypeOf<KeyPath<Post>>().toEqualTypeOf<
      "id" | "title" | "author.name" | "author.profile.bio" | "tags" | "comments.body" | "comments.likes"
    >();
  });

  it("accepts any string for untyped data", () => {
    expectTypeOf<KeyPath<any>>().toEqualTypeOf<string>();
    expectTypeOf<KeyPath<Record<string, unknown>>>().toEqualTypeOf<string>();
  });

  it("has no paths for primitive items", () => {
    expectTypeOf<KeyPath<string>>().toEqualTypeOf<never>();
  });
});

describe("EasySearch generics", () => {
  it("infers the item type from an array", async () => {
    const es = new EasySearch({ data: [{ id: 1, title: "니아" }], keys: ["title"] });
    expectTypeOf(await es.search("니아")).toEqualTypeOf<SearchResult<{ id: number; title: string }>[]>();
  });

  it("infers the item type from an async loader", async () => {
    const es = new EasySearch({ data: () => getPosts(), keys: ["title", { name: "author.name", weight: 2 }] });
    expectTypeOf(es).toEqualTypeOf<EasySearch<Post>>();
    const [first] = await es.search("니아", { keys: ["title"], filter: (post) => post.published });
    expectTypeOf(first!.item).toEqualTypeOf<Post>();
  });

  it("rejects keys that do not exist or are not searchable", () => {
    // @ts-expect-error unknown field
    new EasySearch({ data: () => getPosts(), keys: ["titel"] });
    // @ts-expect-error boolean fields are not indexed
    new EasySearch({ data: () => getPosts(), keys: ["published"] });
    // @ts-expect-error objects are not searchable values, use "author.name"
    new EasySearch({ data: () => getPosts(), keys: [{ name: "author" }] });
    // @ts-expect-error dates are not indexed
    new EasySearch({ data: () => getPosts(), keys: ["createdAt"] });
    const es = new EasySearch({ data: () => getPosts(), keys: ["title"] });
    // @ts-expect-error unknown field in search options
    void es.search("니아", { keys: ["nope"] });
  });
});
