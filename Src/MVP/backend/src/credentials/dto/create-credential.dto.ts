import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { SUPPORTED_PROVIDERS } from "../supported-providers";

export class CreateCredentialDto {
  @IsIn(SUPPORTED_PROVIDERS)
  provider!: string;

  // Deliberately no format pattern: GitHub's PAT format has changed over
  // time (classic 40-char hex, `ghp_`-prefixed, fine-grained
  // `github_pat_...`), and the spec calls for "un controllo di forma, non
  // un pattern rigido" (§4.2). Non-emptiness is all that's checked here —
  // whether it actually works is verified live against GitHub, not guessed
  // from its shape.
  @IsString()
  @IsNotEmpty()
  token!: string;
}
