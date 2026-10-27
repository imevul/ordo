import type { Catalog, Translation } from '../index.ts';

export default {
  list: {
    kicker: 'vyer',
    title: 'Vyer',
    emptyTitle: 'inga sparade vyer',
    emptyBody:
      'Filtrera valfri ärendelista och välj sedan ”Spara vy” för att spara den här för hela arbetsytan – eller bara för dig.',
    private: 'privat',
  },
  view: {
    notFound: 'vyn hittades inte',
    kicker: 'vyer',
    shared: 'delad',
    private: 'privat',
    favorite: 'Favorit',
    delete: 'Radera vy',
    deleted: 'Vyn raderades',
    confirmDeleteTitle: 'Radera ”{name}”?',
    confirmDeleteBody: 'Ärendena påverkas inte.',
  },
} satisfies Translation<Catalog['views']>;
