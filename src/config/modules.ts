// Sidebar sections a user's access can be restricted to (see nav-items.ts on the
// frontend for the same list). "Beranda" is deliberately excluded -- it's always
// reachable, same as every user needing SOME landing page after login.
export const MODULE_KEYS = ["b2b-utama", "b2b-operasional", "zarve", "laporan-keuangan", "administrasi"] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
