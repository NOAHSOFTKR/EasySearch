/**
 * Values EasySearch can index. Other values (booleans, dates, functions,
 * plain objects) are ignored at runtime, so the key types reject them.
 */
export type SearchableValue = string | number | bigint;

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Maximum nesting depth explored by {@link KeyPath}, to keep type checking fast. */
type MaxDepth = 5;

type PathFor<K extends string, V, Depth extends unknown[]> =
  IsAny<V> extends true
    ? K | `${K}.${string}`
    : unknown extends V
      ? K | `${K}.${string}`
      : V extends null | undefined
        ? never
        : V extends SearchableValue
          ? K
          : V extends readonly (infer U)[]
            ? PathFor<K, U, Depth>
            : V extends Date | RegExp | ((...args: never[]) => unknown)
              ? never
              : V extends object
                ? `${K}.${KeyPath<V, [...Depth, unknown]>}`
                : never;

/**
 * Dot-notation paths of `T` that lead to a searchable value
 * (`string`, `number`, `bigint`, or arrays of them).
 *
 * Arrays are traversed transparently: for `{ tags: { name: string }[] }`
 * the path is `"tags.name"`.
 *
 * When `T` is `any` or has an index signature, any string is accepted.
 */
export type KeyPath<T, Depth extends unknown[] = []> =
  IsAny<T> extends true
    ? string
    : Depth["length"] extends MaxDepth
      ? never
      : T extends readonly (infer U)[]
        ? KeyPath<U, Depth>
        : T extends object
          ? { [K in keyof T & string]-?: PathFor<K, T[K], Depth> }[keyof T & string]
          : never;
