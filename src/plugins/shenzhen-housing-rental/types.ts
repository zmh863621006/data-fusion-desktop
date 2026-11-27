export interface HousingBindingTarget {
  acceptanceId: string;
  propertyId: string;
  certificateNumber: string;
  areaId: string;
  cardId: string | null;
}

export interface HousingBindingHouse {
  id: string;
  code: string;
  buildingId: string;
  address: string;
  areaId: string;
}

/** Main-process only; targets and houses must be freshly resolved after a source account/session change. */
export interface HousingBindingClient {
  resolveTarget(acceptanceNumber: string, certificateNumber: string, signal?: AbortSignal): Promise<HousingBindingTarget>;
  findHouse(code: string, target: HousingBindingTarget, signal?: AbortSignal): Promise<HousingBindingHouse | null>;
  isBound(target: HousingBindingTarget, house: HousingBindingHouse, signal?: AbortSignal): Promise<boolean>;
  bindHouse(target: HousingBindingTarget, house: HousingBindingHouse, signal?: AbortSignal): Promise<void>;
}
