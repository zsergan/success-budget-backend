// The part of the request that JwtStrategy.validate() fills in - the only
// part controllers read.
export interface AuthedRequest {
  user: { id: number };
}

// ver is the user's auth_version at issue time; tokens issued before it
// existed carry none.
export interface AccessTokenPayload {
  id: number;
  ver?: number;
}

// Entity relation properties are optional: TypeORM only sets them when a
// query loads them. This marks the relations a query has loaded.
export type WithRelations<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };
