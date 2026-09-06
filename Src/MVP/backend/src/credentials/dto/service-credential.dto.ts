export class ServiceCredentialDto {
  id!: string;
  provider!: string;
  connectedAt!: string; // ISO 8601, date of the last successful validation
}
