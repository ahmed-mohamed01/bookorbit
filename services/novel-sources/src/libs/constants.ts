// Adapted from LNReader, licensed under the MIT license in vendor/lnreader/LICENSE.
export const NovelStatus = {
  Unknown: "Unknown",
  Ongoing: "Ongoing",
  Completed: "Completed",
  Licensed: "Licensed",
  PublishingFinished: "Publishing Finished",
  Cancelled: "Cancelled",
  OnHiatus: "On Hiatus",
  STUB: "STUB",
  Inactive: "Inactive",
} as const;

export const defaultCover = "https://github.com/LNReader/lnreader-plugins/blob/main/icons/src/coverNotAvailable.jpg?raw=true";

export const FilterTypes = {
  TextInput: "Text",
  Picker: "Picker",
  CheckboxGroup: "Checkbox",
  Switch: "Switch",
  ExcludableCheckboxGroup: "XCheckbox",
} as const;

export const isUrlAbsolute = (url: string): boolean => {
  try {
    return Boolean(new URL(url));
  } catch {
    return url.startsWith("//");
  }
};
