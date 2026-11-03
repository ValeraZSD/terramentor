// Why a source could not be read, in the learner's words: each sentence says
// what happened and, where there is one, what to do (the button beside it is
// the source's `fix`). The keys are linkReader.js READ_REASONS plus the file
// path's own; `k()` here, `t()` where it is drawn.
import { k } from '../../i18n';

export const READ_REASON: Record<string, string> = {
    not_a_link: k("That is not a link. Paste an address, like https://example.com/page, or choose a file."),
    refused: k("The app does not open addresses on this computer or its network."),
    no_such_site: k("No site answers at this address. Check the link."),
    not_found: k("The site says this page does not exist. Check the link."),
    blocked: k("The site did not let the app read this page. Save the page as a file and choose it here."),
    scripted: k("This page draws itself in the browser, so there is no text to read. Save it as a PDF and choose the file."),
    site_error: k("The site had a problem answering. Try again in a moment."),
    timeout: k("The site took too long to answer."),
    network: k("The app could not reach the site. Check the connection and try again."),
    too_large: k("This file is bigger than the {{size}} MB the app reads."),
    no_text: k("There is no text in it to learn from. A scan needs its text recognised first."),
    unsupported: k("The app cannot read this kind of file. A PDF, a Word document or a web page works."),
    unreadable: k("The file could not be read. It may be damaged."),
    video_unavailable: k("This video is not available: it was removed, or the link is wrong."),
    video_private: k("This video is private, so the app cannot read it."),
    video_age: k("YouTube asks for a sign-in to watch this video, so the app cannot read its captions. Paste its transcript instead."),
    video_live: k("This is a live stream, and its captions are not ready until it ends. Paste a transcript, or come back after it ends."),
    video_members: k("This video is for the channel's members only. If you can watch it, paste its transcript."),
    token_wall: k("YouTube did not let the app read the captions. Paste the transcript instead."),
    no_captions: k("This video has no captions to read. A course can still be written on its topic."),
};

export const READ_REASON_OTHER = k("The link could not be read.");
