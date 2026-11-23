import type { CardMediaSides } from '../components/CardMedia';

/**
 * A card made from a topic's photo (server/photoCards.js): no words on its
 * front, only the photo asked about. Its answer is the topic, so until it is
 * turned no screen may name the topic or the part of the course it sits in.
 */
export function isPhotoPromptCard(front: string | null | undefined, media: Pick<CardMediaSides, 'front'> | null | undefined): boolean {
    return !String(front ?? '').trim() && !!media?.front?.some(m => m.kind === 'image' && m.prompt);
}
