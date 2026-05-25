import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";
export const IS_PUBLIC_KEY = "isPublic";

export const Roles = (...roles: Array<"admin" | "manager" | "employee" | "auditor">) =>
  SetMetadata(ROLES_KEY, roles);

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
